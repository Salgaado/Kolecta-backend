import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WalletService } from '../wallet/wallet.service';
import { OrdersService } from './orders.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { eq, lte, and, inArray } from 'drizzle-orm';
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
    private readonly ordersService: OrdersService,
  ) {}

  /**
   * Cinto de segurança: cancela pedidos PIX pendentes cujo QR já expirou e que
   * não receberam o webhook de falha da Pagar.me (reconcilia antes; recupera
   * pagos com webhook perdido). O fluxo normal continua sendo o webhook.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleExpiredPixCleanup() {
    try {
      const r = await this.ordersService.sweepExpiredPendingPix();
      if (r.checked > 0) {
        this.logger.log(
          `🧹 Limpeza PIX expirado: ${r.checked} verificado(s), ` +
            `${r.cancelled} cancelado(s), ${r.recovered} recuperado(s) como pago.`,
        );
      }
    } catch (e: any) {
      this.logger.error(`Falha na limpeza de PIX expirado: ${e?.message}`);
    }
  }

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
          // 'delivered' = entrega declarada (rastreio, retirada ou comprador).
          // 'shipped'   = rede de segurança da postagem: o rastreio nunca acusou
          //               a entrega e o comprador nunca confirmou. Sem isto o
          //               saldo do vendedor ficaria retido para sempre.
          inArray(schema.orders.status, ['delivered', 'shipped']),
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
        // ── Gate de disputa (Fase 4.3) ──
        // Disputa aberta CONGELA o release: o dinheiro fica retido até a
        // resolução (a disputa define o destino — estorno ou liberação).
        const openDisputes = await this.db
          .select({ id: schema.disputes.id })
          .from(schema.disputes)
          .where(
            and(
              eq(schema.disputes.orderId, order.id),
              inArray(schema.disputes.status, ['open', 'under_review']),
            ),
          );

        if (openDisputes.length > 0) {
          this.logger.warn(
            `⏸️ Auto-release do pedido ${order.id} congelado: disputa aberta.`,
          );
          continue;
        }

        const sellerNetInCents = order.sellerNetInCents || order.totalInCents;

        // Liberar saldo retido → disponível
        const sellerWallet = await this.walletService.getOrCreateWallet(
          order.sellerId,
        );
        // O motivo aparece no extrato do vendedor — vale distinguir a liberação
        // normal (entrega + 48h) da rede de segurança (postagem sem rastreio).
        const motivo =
          order.status === 'shipped'
            ? 'Prazo de segurança da postagem'
            : 'Auto-release 48h';
        await this.walletService.release(
          sellerWallet.id,
          sellerNetInCents,
          `${motivo} — Pedido #${order.id.slice(0, 8)}`,
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
