import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';

type Database = any;

@Injectable()
export class WalletService {
  constructor(
    @Inject('DATABASE_CONNECTION') private readonly db: Database,
  ) {}

  async getOrCreateWallet(userId: string) {
    let wallet = await this.db.query.wallets.findFirst({
      where: eq(schema.wallets.userId, userId),
    });

    if (!wallet) {
      const [newWallet] = await this.db.insert(schema.wallets).values({
        userId,
        balanceInCents: 0,
        pendingInCents: 0,
      }).returning();
      wallet = newWallet;
    }

    return wallet;
  }

  async credit(walletId: string, amountInCents: number, description: string, orderId?: string) {
    return this.db.transaction(async (tx: any) => {
      const wallet = await tx.query.wallets.findFirst({
        where: eq(schema.wallets.id, walletId),
      });

      if (!wallet) throw new NotFoundException('Wallet not found');

      const newBalance = wallet.balanceInCents + amountInCents;
      await tx.update(schema.wallets)
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

  async debit(walletId: string, amountInCents: number, description: string, orderId?: string) {
    return this.db.transaction(async (tx: any) => {
      const wallet = await tx.query.wallets.findFirst({
        where: eq(schema.wallets.id, walletId),
      });

      if (!wallet) throw new NotFoundException('Wallet not found');
      if (wallet.balanceInCents < amountInCents) {
        throw new BadRequestException('Insufficient balance');
      }

      const newBalance = wallet.balanceInCents - amountInCents;
      await tx.update(schema.wallets)
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

  async hold(walletId: string, amountInCents: number, description: string, orderId?: string) {
    return this.db.transaction(async (tx: any) => {
      const wallet = await tx.query.wallets.findFirst({
        where: eq(schema.wallets.id, walletId),
      });

      if (!wallet) throw new NotFoundException('Wallet not found');

      const newPending = wallet.pendingInCents + amountInCents;
      await tx.update(schema.wallets)
        .set({ pendingInCents: newPending })
        .where(eq(schema.wallets.id, walletId));

      await tx.insert(schema.walletTransactions).values({
        walletId,
        type: 'hold',
        amountInCents,
        status: 'pending',
        description,
        orderId,
      });

      return { success: true, newPending };
    });
  }
}
