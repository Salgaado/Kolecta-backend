import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { MailService } from '../notifications/mail/mail.service';
import { ShippingService } from './shipping.service';

/** Payload de `order.paid` (compra direta) — emitido em orders.service.ts. */
interface OrderPaidEvent {
  orderId: string;
  sellerId: string;
  buyerId: string;
  listingTitle: string;
}

/** Payload de `auction.won` — emitido em auctions.service.ts. */
interface AuctionWonEvent {
  orderId: string;
  winnerId: string;
  listingTitle: string;
  /** true = a captura falhou e o vencedor ainda precisa pagar. */
  needsPayment?: boolean;
}

/**
 * Emissão automática da etiqueta + envio do PDF ao remetente.
 *
 * Os dois caminhos de venda entram aqui: compra direta (`order.paid`) e
 * arremate de leilão (`auction.won`). O vendedor não precisa fazer nada —
 * recebe a etiqueta pronta por e-mail e só posta.
 *
 * Fica no ShippingModule, e não no NotificationsModule, porque isto NÃO é uma
 * notificação: é uma ação que gasta dinheiro da carteira do Melhor Envio. O
 * e-mail é a última etapa dela.
 *
 * Nunca relança: se a etiqueta falhar, a venda já aconteceu e o pedido segue
 * válido. O motivo fica gravado em `orders.shippingLabelError` e o vendedor
 * pode tentar de novo pelo painel.
 */
@Injectable()
export class ShippingLabelListener {
  private readonly logger = new Logger(ShippingLabelListener.name);

  constructor(
    private readonly shipping: ShippingService,
    private readonly mail: MailService,
    private readonly http: HttpService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  @OnEvent('order.paid')
  async aoPagarPedido(event: OrderPaidEvent): Promise<void> {
    await this.emitir(event.orderId, 'compra direta');
  }

  @OnEvent('auction.won')
  async aoArrematar(event: AuctionWonEvent): Promise<void> {
    // Arremate ainda não pago (captura falhou) não gera etiqueta: o pedido está
    // 'pending_payment' e a peça pode voltar ao vendedor.
    if (event.needsPayment) return;
    await this.emitir(event.orderId, 'arremate de leilão');
  }

  private async emitir(orderId: string, origem: string): Promise<void> {
    try {
      const resultado = await this.shipping.emitirEtiquetaDoPedido(orderId);
      if (resultado.jaEstavaPronta) return;

      await this.enviarEtiquetaAoVendedor(orderId, resultado.labelUrl);
      this.logger.log(`Etiqueta de ${origem} pronta e enviada (${orderId}).`);
    } catch (err: any) {
      // A venda já aconteceu — etiqueta que falha não pode derrubar nada.
      this.logger.error(
        `Etiqueta automática falhou (${origem}, pedido ${orderId}): ` +
          `${err?.response?.message ?? err?.message ?? err}`,
      );
    }
  }

  /** Monta e envia o e-mail com o PDF anexado ao remetente (vendedor). */
  private async enviarEtiquetaAoVendedor(
    orderId: string,
    labelUrl: string | null,
  ): Promise<void> {
    const order = await this.db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });
    if (!order) return;

    const [vendedor] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, order.sellerId));

    if (!vendedor?.email) {
      this.logger.warn(
        `Etiqueta pronta mas o vendedor ${order.sellerId} não tem e-mail — pedido ${orderId}.`,
      );
      return;
    }

    const [comprador] = await this.db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, order.buyerId));

    const destino = order.addressId
      ? await this.db.query.addresses.findFirst({
          where: eq(schema.addresses.id, order.addressId),
        })
      : null;

    const listing = order.listingId
      ? await this.db.query.listings.findFirst({
          where: eq(schema.listings.id, order.listingId),
        })
      : null;

    const pdf = labelUrl ? await this.baixarPdf(labelUrl) : null;

    await this.mail.send({
      to: vendedor.email,
      template: 'shipping-label-ready',
      refId: orderId,
      data: {
        sellerName: vendedor.name,
        orderId,
        listingTitle: listing?.title ?? 'Item Kolecta',
        buyerName: comprador?.name ?? null,
        buyerCity: destino ? `${destino.city}/${destino.state}` : null,
        service: order.shippingServiceName ?? null,
        trackingCode: order.trackingCode ?? null,
        labelUrl,
        semAnexo: !pdf,
      },
      attachments: pdf
        ? [{ filename: `etiqueta-${orderId.slice(0, 8)}.pdf`, content: pdf }]
        : undefined,
    });
  }

  /**
   * Baixa o PDF da etiqueta para anexar.
   *
   * Best-effort de propósito: se o download falhar, o e-mail sai com o link em
   * vez do anexo. Segurar a etiqueta inteira por causa de um download seria
   * pior para o vendedor do que um link.
   */
  private async baixarPdf(url: string): Promise<Buffer | null> {
    try {
      const resposta = await firstValueFrom(
        this.http.get(url, { responseType: 'arraybuffer', timeout: 20000 }),
      );
      return Buffer.from(resposta.data as ArrayBuffer);
    } catch (err: any) {
      this.logger.warn(
        `Não foi possível baixar o PDF da etiqueta (${url}): ${err?.message}`,
      );
      return null;
    }
  }
}
