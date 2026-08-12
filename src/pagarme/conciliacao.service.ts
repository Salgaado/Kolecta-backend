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

/** Status de uma cobrança apenas AUTORIZADA (retenção, sem captura). */
const STATUS_RETENCAO = 'authorized_pending_capture';

/** O que a liberação de uma retenção concluiu. */
export interface ResultadoLiberacao {
  chargeId: string;
  statusPagarme: string | null;
  acao: 'liberada' | 'nao-e-retencao' | 'erro-consulta' | 'erro-cancelamento';
  detalhe?: string;
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
   * Cancela uma RETENÇÃO (pré-autorização não capturada), devolvendo o limite
   * ao comprador na hora.
   *
   * Existe porque a retenção do lance ficava de pé depois do arremate pago: o
   * comprador terminava com o valor cobrado E o valor retido comprometidos ao
   * mesmo tempo. O bug foi corrigido para os próximos (a auth passou a ser lida
   * antes da consolidação), mas as retenções já criadas continuam presas até a
   * adquirente expirá-las sozinha — este é o caminho para soltá-las na mão.
   *
   * ⚠️ A consulta ANTES do cancelamento não é conferência preguiçosa, é a
   * salvaguarda principal: na Pagar.me o `DELETE /charges/{id}` cancela uma
   * cobrança autorizada, mas numa cobrança PAGA o mesmo verbo vira ESTORNO.
   * Um id trocado desfaria uma venda e devolveria o dinheiro do vendedor. Por
   * isso só age no status de retenção, e recusa qualquer outro.
   */
  async liberarRetencao(chargeId: string): Promise<ResultadoLiberacao> {
    let charge: any;
    try {
      charge = await this.pagarme.get(`/charges/${chargeId}`);
    } catch (err: unknown) {
      const detalhe = motivoPagarme(err) ?? 'falha na consulta';
      return {
        chargeId,
        statusPagarme: null,
        acao: 'erro-consulta',
        detalhe,
      };
    }

    // O sinal de retenção fica em `last_transaction.status`, NÃO em
    // `charge.status`: uma cobrança pré-autorizada aparece como `pending` no
    // charge, e é a TRANSAÇÃO que diz `authorized_pending_capture`. Já estava
    // documentado em `auctions.service.ts` (ensaio de 31/07) — a primeira
    // versão desta rota leu o campo errado e recusou as duas retenções presas.
    const statusCharge: string | null = charge?.status ?? null;
    const statusTransacao: string | null =
      charge?.last_transaction?.status ?? null;
    const status = statusTransacao ?? statusCharge;

    // Redundante de propósito: mesmo que a transação diga retenção, um charge
    // `paid` significa dinheiro movimentado, e aí o DELETE é estorno. Entre
    // duas leituras discordantes, vale a mais conservadora.
    const houvePagamento =
      statusCharge === 'paid' ||
      !!charge?.paid_at ||
      (typeof charge?.paid_amount === 'number' && charge.paid_amount > 0);

    if (status !== STATUS_RETENCAO || houvePagamento) {
      this.logger.warn(
        `Liberação recusada: ${chargeId} — charge '${statusCharge}', ` +
          `transação '${statusTransacao}'.`,
      );
      return {
        chargeId,
        statusPagarme: status,
        acao: 'nao-e-retencao',
        detalhe:
          `A cobrança está '${statusCharge}' e a transação '${statusTransacao}'. ` +
          `Só uma retenção ('${STATUS_RETENCAO}') pode ser liberada — ` +
          'cancelar uma cobrança paga seria um estorno.',
      };
    }

    try {
      await this.pagarme.delete(`/charges/${chargeId}`);
    } catch (err: unknown) {
      const detalhe = motivoPagarme(err) ?? 'falha no cancelamento';
      this.logger.error(`Falha ao liberar a retenção ${chargeId}: ${detalhe}`);
      return {
        chargeId,
        statusPagarme: status,
        acao: 'erro-cancelamento',
        detalhe,
      };
    }

    const valor = typeof charge?.amount === 'number' ? charge.amount : null;
    this.logger.log(
      `🔓 Retenção ${chargeId} liberada` +
        (valor !== null ? ` (R$ ${(valor / 100).toFixed(2)})` : '') +
        ' — limite devolvido ao comprador.',
    );
    return {
      chargeId,
      statusPagarme: status,
      acao: 'liberada',
      detalhe:
        valor !== null
          ? `R$ ${(valor / 100).toFixed(2)} devolvidos ao limite.`
          : undefined,
    };
  }

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
