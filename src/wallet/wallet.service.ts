import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';

type Database = any;

@Injectable()
export class WalletService {
  constructor(@Inject('DATABASE_CONNECTION') private readonly db: Database) {}

  async getOrCreateWallet(userId: string) {
    let wallet = await this.db.query.wallets.findFirst({
      where: eq(schema.wallets.userId, userId),
    });

    if (!wallet) {
      const [newWallet] = await this.db
        .insert(schema.wallets)
        .values({
          userId,
          balanceInCents: 0,
          pendingInCents: 0,
          withdrawalPendingInCents: 0,
        })
        .returning();
      wallet = newWallet;
    }

    return wallet;
  }

  // ── Credit — adiciona saldo disponível (depósito, estorno, etc.) ───────────

  async credit(
    walletId: string,
    amountInCents: number,
    description: string,
    orderId?: string,
  ) {
    return this.db.transaction(async (tx: any) => {
      const wallet = await tx.query.wallets.findFirst({
        where: eq(schema.wallets.id, walletId),
      });

      if (!wallet) throw new NotFoundException('Wallet not found');

      const newBalance = wallet.balanceInCents + amountInCents;
      await tx
        .update(schema.wallets)
        .set({ balanceInCents: newBalance })
        .where(eq(schema.wallets.id, walletId));

      await tx.insert(schema.walletTransactions).values({
        walletId,
        type: 'credit',
        amountInCents,
        status: 'completed',
        description,
        orderId,
      });

      return { success: true, newBalance };
    });
  }

  // ── Debit — subtrai saldo disponível (compra, saque) ───────────────────────

  async debit(
    walletId: string,
    amountInCents: number,
    description: string,
    orderId?: string,
  ) {
    return this.db.transaction(async (tx: any) => {
      const wallet = await tx.query.wallets.findFirst({
        where: eq(schema.wallets.id, walletId),
      });

      if (!wallet) throw new NotFoundException('Wallet not found');
      if (wallet.balanceInCents < amountInCents) {
        throw new BadRequestException('Insufficient balance');
      }

      const newBalance = wallet.balanceInCents - amountInCents;
      await tx
        .update(schema.wallets)
        .set({ balanceInCents: newBalance })
        .where(eq(schema.wallets.id, walletId));

      await tx.insert(schema.walletTransactions).values({
        walletId,
        type: 'debit',
        amountInCents,
        status: 'completed',
        description,
        orderId,
      });

      return { success: true, newBalance };
    });
  }

  // ── Hold — retém saldo de venda (held_balance / pendingInCents) ────────────

  async hold(
    walletId: string,
    amountInCents: number,
    description: string,
    orderId?: string,
  ) {
    return this.db.transaction(async (tx: any) => {
      const wallet = await tx.query.wallets.findFirst({
        where: eq(schema.wallets.id, walletId),
      });

      if (!wallet) throw new NotFoundException('Wallet not found');

      const newPending = wallet.pendingInCents + amountInCents;
      await tx
        .update(schema.wallets)
        .set({ pendingInCents: newPending })
        .where(eq(schema.wallets.id, walletId));

      await tx.insert(schema.walletTransactions).values({
        walletId,
        type: 'sale_hold_credit',
        amountInCents,
        status: 'pending',
        description,
        orderId,
      });

      return { success: true, newPending };
    });
  }

  // ── Release — move saldo de held (pending) → available (balance) ───────────
  // Chamado quando o comprador confirma recebimento ou após 48h automáticas

  async release(
    walletId: string,
    amountInCents: number,
    description: string,
    orderId?: string,
  ) {
    return this.db.transaction(async (tx: any) => {
      const wallet = await tx.query.wallets.findFirst({
        where: eq(schema.wallets.id, walletId),
      });

      if (!wallet) throw new NotFoundException('Wallet not found');
      if (wallet.pendingInCents < amountInCents) {
        throw new BadRequestException('Insufficient held balance for release');
      }

      // Mover de pending → available
      await tx
        .update(schema.wallets)
        .set({
          pendingInCents: wallet.pendingInCents - amountInCents,
          balanceInCents: wallet.balanceInCents + amountInCents,
        })
        .where(eq(schema.wallets.id, walletId));

      await tx.insert(schema.walletTransactions).values({
        walletId,
        type: 'sale_release',
        amountInCents,
        status: 'completed',
        description,
        orderId,
      });

      return { success: true };
    });
  }

  // ── Hold de LANCE — reserva saldo disponível durante o leilão ──────────────
  // Diferente do hold de venda: aqui o dinheiro SAI do disponível (available →
  // held), pois é o comprador travando saldo para cobrir o lance (Fase 6).

  async holdForBid(
    walletId: string,
    amountInCents: number,
    meta: { auctionId: string; bidId?: string; description: string },
  ) {
    return this.db.transaction(async (tx: any) => {
      const wallet = await tx.query.wallets.findFirst({
        where: eq(schema.wallets.id, walletId),
      });
      if (!wallet) throw new NotFoundException('Wallet not found');
      if (wallet.balanceInCents < amountInCents) {
        throw new BadRequestException(
          'Saldo disponível insuficiente para cobrir o lance.',
        );
      }

      await tx
        .update(schema.wallets)
        .set({
          balanceInCents: wallet.balanceInCents - amountInCents,
          pendingInCents: wallet.pendingInCents + amountInCents,
        })
        .where(eq(schema.wallets.id, walletId));

      await tx.insert(schema.walletTransactions).values({
        walletId,
        type: 'bid_hold',
        amountInCents,
        status: 'pending',
        description: meta.description,
        auctionId: meta.auctionId,
        bidId: meta.bidId,
      });

      return { success: true };
    });
  }

  /** Destrava o hold de um lance superado: held → available (dinheiro volta). */
  async releaseBidHold(
    walletId: string,
    amountInCents: number,
    meta: { auctionId: string; description: string },
  ) {
    return this.db.transaction(async (tx: any) => {
      const wallet = await tx.query.wallets.findFirst({
        where: eq(schema.wallets.id, walletId),
      });
      if (!wallet) throw new NotFoundException('Wallet not found');
      if (wallet.pendingInCents < amountInCents) {
        throw new BadRequestException('Held insuficiente para destravar o lance');
      }

      await tx
        .update(schema.wallets)
        .set({
          pendingInCents: wallet.pendingInCents - amountInCents,
          balanceInCents: wallet.balanceInCents + amountInCents,
        })
        .where(eq(schema.wallets.id, walletId));

      await tx.insert(schema.walletTransactions).values({
        walletId,
        type: 'bid_release',
        amountInCents,
        status: 'completed',
        description: meta.description,
        auctionId: meta.auctionId,
      });

      return { success: true };
    });
  }

  /**
   * Liquida o hold do vencedor ao arrematar: o dinheiro SAI do held como
   * pagamento (não volta ao disponível). É o débito efetivo da compra do leilão.
   */
  async settleBidHold(
    walletId: string,
    amountInCents: number,
    meta: { auctionId: string; orderId?: string; description: string },
  ) {
    return this.db.transaction(async (tx: any) => {
      const wallet = await tx.query.wallets.findFirst({
        where: eq(schema.wallets.id, walletId),
      });
      if (!wallet) throw new NotFoundException('Wallet not found');
      if (wallet.pendingInCents < amountInCents) {
        throw new BadRequestException('Held insuficiente para liquidar o lance');
      }

      await tx
        .update(schema.wallets)
        .set({ pendingInCents: wallet.pendingInCents - amountInCents })
        .where(eq(schema.wallets.id, walletId));

      await tx.insert(schema.walletTransactions).values({
        walletId,
        type: 'bid_settle',
        amountInCents,
        status: 'completed',
        description: meta.description,
        auctionId: meta.auctionId,
        orderId: meta.orderId,
      });

      return { success: true };
    });
  }

  // ── Listar transações do usuário ──────────────────────────────────────────

  async getTransactions(userId: string) {
    const wallet = await this.getOrCreateWallet(userId);

    return this.db
      .select()
      .from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.walletId, wallet.id))
      .orderBy(schema.walletTransactions.createdAt);
  }
}
