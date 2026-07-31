import {
  Injectable,
  Inject,
  BadRequestException,
  BadGatewayException,
  Logger,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import { PagarmeService } from '../pagarme/pagarme.service';
import { WalletService } from '../wallet/wallet.service';
import * as schema from '../database/schema';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';

// Mínimo de saque: R$50,00 (configurável via env)
const WITHDRAWAL_MIN_CENTS = parseInt(
  process.env.WITHDRAWAL_MIN_AMOUNT_CENTS ?? '5000',
  10,
);

/** Resposta mínima do POST /transfers da Pagar.me. */
interface PagarmeTransfer {
  id: string;
  status?: string;
}

/**
 * Saque do vendedor: move o saldo DISPONÍVEL da wallet (espelho do recebedor
 * Pagar.me) para a conta bancária cadastrada, via `POST /transfers`.
 *
 * Substitui o fluxo Stripe Connect (`transfers.create` + `stripeAccountId`).
 * O transfer da Pagar.me é ASSÍNCRONO: o saque nasce `processing` e só vira
 * `paid`/`failed` pelo webhook `transfer.*` (`pagarme.transfer.updated`).
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly pagarme: PagarmeService,
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

    // Regra 1: valor mínimo
    if (amountInCents < WITHDRAWAL_MIN_CENTS) {
      throw new BadRequestException(
        `O valor mínimo para saque é R$${WITHDRAWAL_MIN_CENTS / 100},00`,
      );
    }

    // Regra 2 + gate (5.2): recebedor Pagar.me apto a sacar
    const [sellerProfile] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!sellerProfile?.pagarmeRecipientId) {
      throw new BadRequestException(
        'Recebedor Pagar.me não configurado. Conclua o cadastro de recebimentos primeiro.',
      );
    }
    if (!sellerProfile.canWithdraw) {
      throw new BadRequestException(
        'Sua conta ainda não está habilitada para saques. Conclua a verificação (prova de vida).',
      );
    }

    // Regra 3: saldo disponível na wallet
    const wallet = await this.walletService.getOrCreateWallet(userId);
    if (wallet.balanceInCents < amountInCents) {
      throw new BadRequestException(
        'Saldo disponível insuficiente para este saque.',
      );
    }

    // Debita o disponível imediatamente (fica "em trânsito"); reversão em falha.
    await this.walletService.debit(
      wallet.id,
      amountInCents,
      'Saque para conta bancária (Pagar.me)',
    );

    // Registra o saque como PROCESSING antes de chamar o gateway (idempotência
    // estável por linha + rastreabilidade caso o POST caia).
    const [withdrawal] = await this.db
      .insert(schema.withdrawalRequests)
      .values({
        userId,
        amountInCents,
        status: 'processing',
        pagarmeRecipientId: sellerProfile.pagarmeRecipientId,
      })
      .returning();

    try {
      // NOTA (ponta P-transfer) — sondado na conta nova em 31/07, os DOIS
      // endpoints existem e se comportam diferente:
      //
      //   `POST /transfers`                    → 401 "IP de origem não
      //     autorizado a realizar essa operação". Só responde de IP na
      //     allowlist do dashboard. É o caminho que roda em produção hoje
      //     (a allowlist da conta ANTIGA já tem os IPs da Render) — e por isso
      //     mesmo é o que quebra na virada de conta se a allowlist nova não
      //     for preenchida antes. O 401 não fala de saque nem de saldo, então
      //     o erro chega ao vendedor como falha genérica.
      //
      //   `POST /recipients/{id}/withdrawals`  → não é filtrado por IP; criou
      //     um `with_...` de verdade (que nasceu `failed` por falta de saldo
      //     disponível — o dinheiro do cartão fica em `waiting_funds`).
      //
      // Mantido em `/transfers` de propósito: é o que já funciona em produção,
      // e um 401 de IP não é evidência de endpoint errado. Ver
      // docs/PLAN-pagarme-conta-nova.md (bloqueio 6).
      const transfer = await this.pagarme.post<PagarmeTransfer>(
        '/transfers',
        {
          amount: amountInCents,
          recipient_id: sellerProfile.pagarmeRecipientId,
          metadata: { userId, withdrawalId: withdrawal.id },
        },
        `withdrawal-${withdrawal.id}`, // Idempotency-Key
      );

      await this.db
        .update(schema.withdrawalRequests)
        .set({ pagarmeTransferId: transfer.id, updatedAt: new Date() })
        .where(eq(schema.withdrawalRequests.id, withdrawal.id));

      this.logger.log(
        `💸 Saque ${withdrawal.id} criado (transfer ${transfer.id}, status ${transfer.status ?? 'processing'}) — seller ${userId}`,
      );

      return { ...withdrawal, pagarmeTransferId: transfer.id };
    } catch (err: any) {
      // Falha ao criar o transfer → estorna o débito e marca o saque como failed.
      await this.walletService.credit(
        wallet.id,
        amountInCents,
        `Estorno — falha ao criar saque #${withdrawal.id.slice(0, 8)}`,
      );
      await this.db
        .update(schema.withdrawalRequests)
        .set({
          status: 'failed',
          failureReason: 'Falha ao criar transfer na Pagar.me',
          updatedAt: new Date(),
        })
        .where(eq(schema.withdrawalRequests.id, withdrawal.id));

      this.logger.error(
        `❌ Saque ${withdrawal.id} falhou na criação do transfer. Saldo estornado. ${err?.message ?? ''}`,
      );
      throw new BadGatewayException(
        'Não foi possível processar o saque agora. O saldo foi mantido.',
      );
    }
  }

  // ── Webhook: transfer.* → conclui ou reverte o saque ──────────────────────

  /**
   * Emitido pelo webhook unificado para qualquer `transfer.*`. O `data` é o
   * objeto transfer da Pagar.me; o `status` define o desfecho. Idempotente.
   */
  @OnEvent('pagarme.transfer.updated')
  async handleTransferUpdated(data: any) {
    const transferId = data?.id;
    const status = data?.status;
    if (!transferId) {
      this.logger.warn('transfer.* sem id no payload — ignorado.');
      return;
    }

    const [withdrawal] = await this.db
      .select()
      .from(schema.withdrawalRequests)
      .where(eq(schema.withdrawalRequests.pagarmeTransferId, transferId));

    if (!withdrawal) {
      this.logger.warn(`Nenhum saque para pagarmeTransferId=${transferId}.`);
      return;
    }

    // Estado terminal já processado → idempotência.
    if (withdrawal.status === 'paid' || withdrawal.status === 'failed') {
      return;
    }

    if (status === 'paid') {
      await this.db
        .update(schema.withdrawalRequests)
        .set({ status: 'paid', updatedAt: new Date() })
        .where(eq(schema.withdrawalRequests.id, withdrawal.id));
      this.logger.log(`✅ Saque ${withdrawal.id} PAGO (transfer ${transferId}).`);
      return;
    }

    if (status === 'failed' || status === 'canceled') {
      // Reverte o saldo (o transfer não saiu).
      const wallet = await this.walletService.getOrCreateWallet(
        withdrawal.userId,
      );
      await this.walletService.credit(
        wallet.id,
        withdrawal.amountInCents,
        `Estorno — saque não concluído #${withdrawal.id.slice(0, 8)}`,
      );
      await this.db
        .update(schema.withdrawalRequests)
        .set({
          status: 'failed',
          failureReason: data?.status_reason ?? `transfer ${status}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.withdrawalRequests.id, withdrawal.id));
      this.logger.error(
        `❌ Saque ${withdrawal.id} ${status}. Saldo estornado para ${withdrawal.userId}.`,
      );
      return;
    }

    // pending/processing/created → segue em 'processing' (sem ação).
    this.logger.log(
      `Saque ${withdrawal.id}: transfer ${transferId} em '${status}'.`,
    );
  }
}
