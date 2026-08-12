import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConciliacaoService } from './conciliacao.service';

/**
 * Varredura periódica contra a API da Pagar.me.
 *
 * O webhook é push, e todo modo de falha dele está fora do nosso controle: pode
 * não ser enviado (a URL congela no evento), pode se perder num deploy, e pode
 * ser engolido pela nossa própria idempotência — foi o que aconteceu em 12/08,
 * quando um arremate de R$ 200 pago pelo painel ficou invisível no sistema.
 *
 * Este cron é a rede embaixo: em vez de esperar sermos avisados, perguntamos.
 */
@Injectable()
export class ConciliacaoCron {
  private readonly logger = new Logger(ConciliacaoCron.name);

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleConciliarPendentes() {
    const r = await this.conciliacao.conciliarPendentes();
    if (r.verificados === 0) return;

    // Silêncio quando está tudo consistente: o valor do log está em avisar
    // divergência, e uma linha a cada 10 minutos dizendo "nada mudou" só
    // treinaria quem lê a ignorar o arquivo inteiro.
    if (r.liquidados.length > 0) {
      this.logger.warn(
        `⚠️ ${r.liquidados.length} pedido(s) estavam PAGOS na Pagar.me e ` +
          `pendentes aqui — liquidados agora: ${r.liquidados.join(', ')}. ` +
          'Divergência assim significa que um webhook não chegou ou não agiu.',
      );
    }
    if (r.errosDeConsulta.length > 0) {
      this.logger.error(
        `🚨 ${r.errosDeConsulta.length} pedido(s) não puderam ser conferidos ` +
          `na Pagar.me: ${r.errosDeConsulta.join(', ')}. Eles NÃO são tratados ` +
          'como não-pagos — ficam para a próxima rodada.',
      );
    }
    if (r.semReferencia.length > 0) {
      this.logger.log(
        `${r.semReferencia.length} pedido(s) em aberto sem cobrança criada na ` +
          `Pagar.me (nada a conferir): ${r.semReferencia.join(', ')}.`,
      );
    }
  }

  constructor(private readonly conciliacao: ConciliacaoService) {}
}
