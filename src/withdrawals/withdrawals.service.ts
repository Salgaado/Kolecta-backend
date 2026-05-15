import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import { StripeService } from '../stripe/stripe.service';
import { WalletService } from '../wallet/wallet.service';
import * as schema from '../database/schema';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';

// Mínimo de saque: R$50,00 (configurável via env)
const WITHDRAWAL_MIN_CENTS = parseInt(
  process.env.WITHDRAWAL_MIN_AMOUNT_CENTS ?? '5000',
  10,
);

@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly stripeService: StripeService,
    private readonly walletService: WalletService,
  ) {}

  // ── Listar saques do seller autenticado ──────────────────────────────────

  async findMyWithdrawals(userId: string) {
    return this.db
      .select()
      .from(schema.withdrawalRequests)
      .where(eq(schema.withdrawalRequests.userId, userId));
  }

  // ── Solicitar saque ──────────────────────────────────────────────────────

  async requestWithdrawal(userId: string, dto: RequestWithdrawalDto) {
    const { amountInCents } = dto;

    // Regra 1: Valor mínimo de R$50,00
    if (amountInCents < WITHDRAWAL_MIN_CENTS) {
      throw new BadRequestException(
        `O valor mínimo para saque é R$${WITHDRAWAL_MIN_CENTS / 100},00`,
      );
    }

    // Regra 2: Buscar seller_profile para obter stripeAccountId
    const [sellerProfile] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!sellerProfile?.stripeAccountId) {
      throw new BadRequestException(
        'Conta Stripe Connect não configurada. Conclua o onboarding primeiro.',
      );
    }

    // Regra 3: Verificar se a conta Express está habilitada para saques
    const account = await this.stripeService.stripeClient.accounts.retrieve(
      sellerProfile.stripeAccountId,
    );

    if (!account.charges_enabled || !account.payouts_enabled) {
      throw new BadRequestException(
        'Sua conta Stripe ainda não está verificada para receber saques.',
      );
    }

    // Regra 4: Verificar saldo disponível na wallet
    const wallet = await this.walletService.getOrCreateWallet(userId);

    if (wallet.balanceInCents < amountInCents) {
      throw new BadRequestException(
        'Saldo disponível insuficiente para este saque.',
      );
    }

    // Executar tudo em transação atômica
    return this.db.transaction(async (tx: any) => {
      // Debitar da wallet imediatamente (saldo fica em trânsito)
      await tx
        .update(schema.wallets)
        .set({
          balanceInCents: wallet.balanceInCents - amountInCents,
          updatedAt: new Date(),
        })
        .where(eq(schema.wallets.userId, userId));

      // Registrar a transação no ledger
      await tx.insert(schema.walletTransactions).values({
        walletId: wallet.id,
        type: 'debit',
        amountInCents,
        status: 'completed',
        description: `Saque para Stripe Express`,
      });

      // Criar o Transfer no Stripe para o seller
      const transfer = await this.stripeService.stripeClient.transfers.create({
        amount: amountInCents,
        currency: 'brl',
        destination: sellerProfile.stripeAccountId!,
        description: `Saque Kolecta — ${userId.slice(0, 8)}`,
        metadata: {
          userId,
        },
      });

      // Registrar o saque no banco como CONCLUÍDO (pois transfer é instantâneo)
      const [withdrawal] = await tx
        .insert(schema.withdrawalRequests)
        .values({
          userId,
          amountInCents,
          status: 'paid',
          stripePayoutId: transfer.id, // Armazenando o ID do transfer aqui
          stripeAccountId: sellerProfile.stripeAccountId,
        })
        .returning();

      this.logger.log(
        `✅ Saque ${withdrawal.id} concluído via Transfer Stripe: ${transfer.id} | Seller: ${userId}`,
      );

      return withdrawal;
    });
  }

  // ── Webhook: payout.paid → saque concluído ───────────────────────────────

  @OnEvent('stripe.payout.paid')
  async handlePayoutPaid(payout: any) {
    this.logger.log(`Processando payout.paid: ${payout.id}`);

    const [withdrawal] = await this.db
      .select()
      .from(schema.withdrawalRequests)
      .where(eq(schema.withdrawalRequests.stripePayoutId, payout.id));

    if (!withdrawal) {
      this.logger.warn(
        `Nenhum saque encontrado para stripePayoutId=${payout.id}`,
      );
      return;
    }

    await this.db
      .update(schema.withdrawalRequests)
      .set({ status: 'paid', updatedAt: new Date() })
      .where(eq(schema.withdrawalRequests.id, withdrawal.id));

    // Marcar a transação no ledger como completed
    await this.db
      .update(schema.walletTransactions)
      .set({ status: 'completed' })
      .where(eq(schema.walletTransactions.walletId, withdrawal.userId));

    this.logger.log(`✅ Saque ${withdrawal.id} confirmado como PAGO.`);
  }

  // ── Webhook: payout.failed → reverter saldo ──────────────────────────────

  @OnEvent('stripe.payout.failed')
  async handlePayoutFailed(payout: any) {
    this.logger.error(`Processando payout.failed: ${payout.id}`);

    const [withdrawal] = await this.db
      .select()
      .from(schema.withdrawalRequests)
      .where(eq(schema.withdrawalRequests.stripePayoutId, payout.id));

    if (!withdrawal) {
      this.logger.warn(
        `Nenhum saque encontrado para stripePayoutId=${payout.id}`,
      );
      return;
    }

    // Reverter o débito na wallet
    const wallet = await this.walletService.getOrCreateWallet(
      withdrawal.userId,
    );

    await this.db.transaction(async (tx: any) => {
      await tx
        .update(schema.wallets)
        .set({
          balanceInCents: wallet.balanceInCents + withdrawal.amountInCents,
          updatedAt: new Date(),
        })
        .where(eq(schema.wallets.userId, withdrawal.userId));

      await tx
        .update(schema.withdrawalRequests)
        .set({
          status: 'failed',
          failureReason: payout.failure_message ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(schema.withdrawalRequests.id, withdrawal.id));
    });

    this.logger.error(
      `❌ Saque ${withdrawal.id} FALHOU. Saldo revertido para o seller ${withdrawal.userId}.`,
    );
  }
}
