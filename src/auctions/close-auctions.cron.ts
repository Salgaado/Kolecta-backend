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
   * Fase 3 — arma a retenção do líder nos leilões que entraram na reta final.
   *
   * Roda de hora em hora, e a frequência aqui não custa nada: a varredura é uma
   * consulta ao banco, e só quem PRECISA de retenção fala com a Pagar.me. O que
   * limita as tentativas no cartão não é o intervalo do cron — é o teto por
   * lance (`HOLD_MAX_ATTEMPTS`), gravado no próprio lance.
   *
   * Foi o oposto disso que quebrou: o cron antigo renovava a cada 6h e, quando
   * o cartão recusava, tentava de novo para sempre. 16 recusas seguidas no
   * cartão de um comprador que nem tinha arrematado.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleArmarRetencoesDeLideres() {
    const { armadas, falhas, desistidas } =
      await this.auctionsService.armarRetencoesDeLideres();
    if (armadas.length > 0) {
      this.logger.log(
        `${armadas.length} retenção(ões) de lance armada(s): ${armadas.join(', ')}`,
      );
    }
    if (falhas.length > 0) {
      this.logger.warn(
        `${falhas.length} retenção(ões) adiada(s) para nova tentativa: ${falhas.join(', ')}`,
      );
    }
    if (desistidas.length > 0) {
      this.logger.error(
        `${desistidas.length} retenção(ões) DESISTIDA(S) por teto de tentativas: ` +
          `${desistidas.join(', ')}. Os licitantes foram avisados.`,
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
