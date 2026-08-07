import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, isNotNull, or, lt, isNull } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { ShippingService } from './shipping.service';

/**
 * Segue os envios em trânsito no Melhor Envio.
 *
 * Puxa, não recebe: o ME não manda webhook de rastreio para a nossa conta, então
 * de tempos em tempos a gente consulta os envios que ainda não chegaram. Quando
 * um deles é entregue, o ShippingService emite o evento e o pedido avança
 * sozinho (ver OrdersService.aoEntregarPeloRastreio).
 *
 * O intervalo é de 3h porque rastreio não muda de minuto em minuto e cada
 * consulta gasta do limite do ME. É curto o bastante para a entrega refletir no
 * mesmo dia e liberar o saldo do vendedor no tempo certo.
 */
@Injectable()
export class RastreioCron {
  private readonly logger = new Logger(RastreioCron.name);

  /** Não reconsulta um envio checado há menos disso. */
  private static readonly FRESCOR_MS = 3 * 60 * 60 * 1000;
  /** Folga entre chamadas ao ME, para não estourar o limite dele. */
  private static readonly INTERVALO_MS = 400;
  /** Teto por rodada: o resto fica para a próxima, sem segurar a fila. */
  private static readonly MAX_POR_RODADA = 120;

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: any,
    private readonly shipping: ShippingService,
  ) {}

  @Cron(CronExpression.EVERY_3_HOURS)
  async rodada() {
    const limite = new Date(Date.now() - RastreioCron.FRESCOR_MS);

    // Envios que valem consultar: TÊM envio no ME, ainda NÃO constam entregues, e
    // o pedido está numa fase em que a entrega importa. 'delivered'/'completed'
    // ficam de fora: já chegaram. Checado há pouco também fica de fora.
    const pedidos = await this.db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(
        and(
          isNotNull(schema.orders.shippingCartId),
          isNull(schema.orders.shippingDeliveredAt),
          or(
            eq(schema.orders.status, 'shipped'),
            eq(schema.orders.status, 'paid'),
          ),
          or(
            isNull(schema.orders.trackingCheckedAt),
            lt(schema.orders.trackingCheckedAt, limite),
          ),
        ),
      )
      .limit(RastreioCron.MAX_POR_RODADA);

    if (pedidos.length === 0) return;

    let ok = 0;
    let entregues = 0;
    let falhas = 0;
    for (const [i, p] of pedidos.entries()) {
      if (i > 0) await espera(RastreioCron.INTERVALO_MS);
      try {
        const r = await this.shipping.rastrearPedido(p.id);
        ok++;
        if (r?.etapaAtual === 'entregue') entregues++;
      } catch (err: any) {
        // Um envio problemático (cart sumido, ME fora do ar) não derruba a
        // varredura dos outros. Fica para a próxima rodada.
        falhas++;
        this.logger.error(
          `Rastreio do pedido ${p.id} falhou: ${err?.message ?? err}`,
        );
      }
    }

    this.logger.log(
      `Rastreio: ${pedidos.length} envio(s) checado(s), ${ok} ok, ` +
        `${entregues} entregue(s), ${falhas} com falha.`,
    );
  }
}

function espera(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
