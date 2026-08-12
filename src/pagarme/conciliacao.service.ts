import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { PagarmeService } from './pagarme.service';
import { motivoPagarme } from './pagarme-erro';

/**
 * Evento interno que corresponde a uma order PAGA na Pagar.me.
 *
 * Mora aqui, e não no controller do webhook, porque o webhook (push) e a
 * conciliação (pull) precisam terminar no MESMO handler. Foi a divergência
 * entre dois caminhos que criou o incidente de 12/08; um terceiro caminho com
 * roteamento próprio recriaria o problema numa variação nova.
 */
export function eventoDeOrderPaga(metadataType?: string): string {
  return metadataType === 'bid_payment'
    ? 'pagarme.auction.paid'
    : 'pagarme.order.paid';
}

/** O que a conciliação concluiu sobre um pedido. */
export interface ResultadoConciliacao {
  orderId: string;
  statusLocal: string;
  /** Status na Pagar.me, ou null quando não deu para consultar. */
  statusPagarme: string | null;
  acao:
    | 'liquidado' // estava pago lá e não aqui — resolvido agora
    | 'ja-consistente' // os dois lados concordam
    | 'nao-pago' // continua pendente na Pagar.me também
    | 'sem-referencia' // não sabemos qual order consultar
    | 'erro-consulta';
  detalhe?: string;
}

/**
 * Conciliação com a Pagar.me: pergunta o estado REAL de um pedido e conserta o
 * nosso lado quando os dois divergem.
 *
 * Existe porque o webhook é push, e todo modo de falha dele está fora do nosso
 * controle: pode não ser enviado (a URL congela no evento), pode se perder num
 * deploy, e — o caso de 12/08 — pode ser engolido pela nossa própria
 * idempotência, gravado como `processed` sem nada ter sido feito.
 *
 * Por isso a fonte de verdade aqui é a API da Pagar.me, NUNCA a nossa tabela
 * `webhook_events`: um conciliador que confiasse nela concluiria que estava
 * tudo certo justamente no caso que ele existe para pegar.
 */
@Injectable()
export class ConciliacaoService {
  private readonly logger = new Logger(ConciliacaoService.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: any,
    private readonly pagarme: PagarmeService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Estados em que ainda faz sentido perguntar à Pagar.me. */
  private readonly PENDENTES = ['pending', 'pending_payment'];

  /**
   * Concilia UM pedido.
   *
   * @param pagarmeOrderIdInformado usado quando o nosso banco não guardou a
   *   referência — o caso de uma cobrança recusada, em que o id era descartado
   *   junto com a exceção. Vale a pena poder passar à mão: sem isso o
   *   conciliador nasceria cego exatamente nos pedidos que ele deve cobrir.
   */
  async conciliarPedido(
    orderId: string,
    pagarmeOrderIdInformado?: string,
  ): Promise<ResultadoConciliacao> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) {
      return {
        orderId,
        statusLocal: 'inexistente',
        statusPagarme: null,
        acao: 'sem-referencia',
        detalhe: 'Pedido não encontrado.',
      };
    }

    // Já terminou de um jeito ou de outro: não há o que conciliar.
    if (!this.PENDENTES.includes(order.status)) {
      return {
        orderId,
        statusLocal: order.status,
        statusPagarme: null,
        acao: 'ja-consistente',
      };
    }

    const pagarmeOrderId = pagarmeOrderIdInformado || order.pagarmeOrderId;
    if (!pagarmeOrderId) {
      return {
        orderId,
        statusLocal: order.status,
        statusPagarme: null,
        acao: 'sem-referencia',
        detalhe:
          'Pedido sem `pagarme_order_id`. Informe o id da order na Pagar.me para conciliar.',
      };
    }

    let remoto: any;
    try {
      remoto = await this.pagarme.get(`/orders/${pagarmeOrderId}`);
    } catch (err: unknown) {
      const detalhe = motivoPagarme(err) ?? 'falha na consulta';
      this.logger.error(
        `Conciliação do pedido ${orderId} falhou ao consultar ${pagarmeOrderId}: ${detalhe}`,
      );
      return {
        orderId,
        statusLocal: order.status,
        statusPagarme: null,
        acao: 'erro-consulta',
        detalhe,
      };
    }

    const charge = remoto?.charges?.[0];
    const pago = remoto?.status === 'paid' || charge?.status === 'paid';

    if (!pago) {
      return {
        orderId,
        statusLocal: order.status,
        statusPagarme: remoto?.status ?? null,
        acao: 'nao-pago',
      };
    }

    // Pago lá, pendente aqui. Dispara o MESMO evento que o webhook dispararia
    // — inclusive o `metadata`, para o roteamento decidir igual. Os handlers já
    // são idempotentes, então uma conciliação repetida sai calada.
    const evento = eventoDeOrderPaga(remoto?.metadata?.type);
    this.logger.warn(
      `⚠️ Divergência conciliada: pedido ${orderId} estava '${order.status}' ` +
        `aqui e 'paid' na Pagar.me (${pagarmeOrderId}). Disparando ${evento}.`,
    );

    // `metadata.orderId` é o que os handlers leem. Se a order remota veio sem
    // metadata (cobrança criada fora do nosso fluxo), preenchemos com o pedido
    // que estamos conciliando — é justamente o que se sabe aqui e lá não.
    await this.eventEmitter.emitAsync(evento, {
      ...remoto,
      metadata: { ...(remoto?.metadata ?? {}), orderId },
    });

    return {
      orderId,
      statusLocal: order.status,
      statusPagarme: 'paid',
      acao: 'liquidado',
      detalhe: `Evento ${evento} disparado a partir de ${pagarmeOrderId}.`,
    };
  }
}
