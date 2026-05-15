import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WalletService } from '../wallet/wallet.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { eq, lte, and } from 'drizzle-orm';
import * as schema from '../database/schema';

type Database = any;

/**
 * Job agendado para liberar automaticamente o saldo retido do vendedor
 * após 48h da marcação de entrega, caso o comprador não confirme antes.
 *
 * Regra canônica: Se o comprador não confirmar recebimento em 48h,
 * o saldo é liberado automaticamente.
 */
@Injectable()
export class ReleaseBalanceCron {
  private readonly logger = new Logger(ReleaseBalanceCron.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly walletService: WalletService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleAutoRelease() {
    const now = new Date();
    this.logger.log(`⏰ Verificando pedidos para auto-release de saldo...`);

    // Buscar pedidos com status 'delivered' e auto_release_at <= agora
    const ordersToRelease = await this.db
      .select()
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.status, 'delivered'),
          lte(schema.orders.autoReleaseAt, now),
        ),
      );

    if (ordersToRelease.length === 0) {
      this.logger.log(`Nenhum pedido para auto-release no momento.`);
      return;
    }

    this.logger.log(
      `📋 ${ordersToRelease.length} pedido(s) elegíveis para auto-release.`,
    );

    for (const order of ordersToRelease) {
      try {
        const sellerNetInCents = order.sellerNetInCents || order.totalInCents;

        // Liberar saldo retido → disponível
        const sellerWallet = await this.walletService.getOrCreateWallet(
          order.sellerId,
        );
        await this.walletService.release(
          sellerWallet.id,
          sellerNetInCents,
          `Auto-release 48h — Pedido #${order.id.slice(0, 8)}`,
          order.id,
        );

        // Marcar pedido como completed
        await this.db
          .update(schema.orders)
          .set({
            status: 'completed',
            completedAt: now,
          })
          .where(eq(schema.orders.id, order.id));

        this.logger.log(
          `✅ Auto-release: Pedido ${order.id} completado. ${sellerNetInCents / 100} BRL liberados para seller ${order.sellerId}`,
        );
      } catch (error: any) {
        this.logger.error(
          `❌ Falha no auto-release do pedido ${order.id}: ${error.message}`,
        );
      }
    }
  }
}
