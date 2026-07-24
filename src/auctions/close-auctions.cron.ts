import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuctionsService } from './auctions.service';

@Injectable()
export class CloseAuctionsCron {
  private readonly logger = new Logger(CloseAuctionsCron.name);

  constructor(private readonly auctionsService: AuctionsService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCloseExpiredAuctions() {
    this.logger.log('Verificando leilões expirados...');
    const closed = await this.auctionsService.endExpiredAuctions();
    if (closed.length > 0) {
      this.logger.log(`${closed.length} leilão(ões) encerrado(s): ${closed.join(', ')}`);
    }
  }

  /**
   * Fase 3 — renova as pré-autorizações dos lances líderes que estão perto de
   * expirar (leilões que duram mais que a janela da adquirente ~5 dias). Roda a
   * cada 6h: cada auth entra na janela de renovação (~24h) e é renovada uma vez.
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async handleReauthorizeExpiringBids() {
    this.logger.log('Verificando pré-autorizações de lance a expirar...');
    const { reauthorized, failed } =
      await this.auctionsService.reauthorizeExpiringBids();
    if (reauthorized.length > 0) {
      this.logger.log(
        `${reauthorized.length} pré-auth(s) de lance renovada(s): ${reauthorized.join(', ')}`,
      );
    }
    if (failed.length > 0) {
      this.logger.warn(
        `${failed.length} pré-auth(s) de lance NÃO renovada(s): ${failed.join(', ')}`,
      );
    }
  }

  /**
   * Fase 4 — expira arremates `pending_payment` cujo prazo de pagamento venceu:
   * cancela o pedido e oferece ao 2º colocado (ou reabre o anúncio). Roda de
   * hora em hora (o prazo é de horas, não minutos).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleExpireOverduePendingPayments() {
    this.logger.log('Verificando arremates com prazo de pagamento vencido...');
    const { expired, offered, reopened } =
      await this.auctionsService.expireOverduePendingPayments();
    if (expired.length > 0) {
      this.logger.warn(
        `${expired.length} arremate(s) expirado(s): ` +
          `${offered.length} oferecido(s) ao 2º colocado, ${reopened.length} reaberto(s).`,
      );
    }
  }
}
