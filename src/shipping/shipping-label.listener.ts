import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { MailService } from '../notifications/mail/mail.service';
import { BRAND } from '../notifications/templates/layout';
import { ShippingService } from './shipping.service';

/** Payload de `order.paid` (compra direta) — emitido em orders.service.ts. */
interface OrderPaidEvent {
  orderId: string;
  sellerId: string;
  buyerId: string;
  listingTitle: string;
}

/**
 * Payload de `auction.paid` — emitido em auctions.service.ts quando o vencedor
 * paga o arremate (lance + frete que ele escolheu).
 */
interface AuctionPaidEvent {
  orderId: string;
  buyerId: string;
  sellerId: string;
  totalInCents: number;
  shippingInCents: number;
  deliveryMethod: string;
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

  /**
   * Arremate pago. NÃO escuta `auction.won`: aquele evento sai no fecho do
   * leilão, quando o vencedor ainda nem escolheu o frete e nada foi cobrado —
   * comprar etiqueta ali seria gastar antes de receber, e com um serviço que o
   * comprador não escolheu. A etiqueta só faz sentido depois do pagamento.
   */
  @OnEvent('auction.paid')
  async aoArrematar(event: AuctionPaidEvent): Promise<void> {
    // Retirada em mãos não tem etiqueta a emitir.
    if (event.deliveryMethod === 'pickup') return;
    await this.emitir(event.orderId, 'arremate de leilão');
  }

  /**
   * O e-mail com o PDF sai daqui, e não do fluxo da compra: a etiqueta também é
   * emitida pelo botão "tentar de novo" do vendedor, que não passa por evento
   * de pedido. Quem emite avisa; quem avisa dispara o e-mail.
   */
  @OnEvent('shipping.label.ready')
  async aoFicarPronta(evento: {
    orderId: string;
    labelUrl: string | null;
  }): Promise<void> {
    try {
      await this.enviarEtiquetaAoVendedor(evento.orderId, evento.labelUrl);
    } catch (err: any) {
      this.logger.error(
        `Falha ao enviar a etiqueta do pedido ${evento.orderId}: ${err?.message ?? err}`,
      );
    }
  }

  private async emitir(orderId: string, origem: string): Promise<void> {
    try {
      await this.shipping.emitirEtiquetaDoPedido(orderId);
      this.logger.log(`Etiqueta de ${origem} emitida (${orderId}).`);
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

    // O PDF vem do arquivo da S3 (via ShippingService), não da URL do print —
    // aquela é página de painel e chegava como HTML.
    //
    // Pede o `completo`: etiqueta E declaração de conteúdo, uma em cada página. A
    // declaração é obrigatória em envio sem nota fiscal, e todo envio daqui é
    // assim. Ela sempre esteve disponível na API; o e-mail simplesmente anexava
    // só a etiqueta, e o vendedor descobria a falta no balcão dos Correios.
    //
    // A DC-e é assíncrona no Melhor Envio, então pode não estar pronta neste
    // instante. `contem` diz o que veio de verdade, e o texto do e-mail muda de
    // acordo em vez de prometer o que não está anexado.
    let pdf: Buffer | null = null;
    let nomeDoAnexo = `etiqueta-${orderId.slice(0, 8)}.pdf`;
    let comDeclaracao = false;
    try {
      const arquivo = await this.shipping.obterPdfDaEtiqueta(
        orderId,
        'completo',
      );
      pdf = arquivo.arquivo;
      nomeDoAnexo = arquivo.nome;
      comDeclaracao = arquivo.contem === 'completo';
      if (!comDeclaracao) {
        this.logger.warn(
          `Pedido ${orderId}: declaração de conteúdo ainda não disponível no ` +
            `Melhor Envio, e-mail vai só com a etiqueta.`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Etiqueta do pedido ${orderId} sem PDF para anexar: ${err?.message ?? err}`,
      );
    }

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
        // NÃO manda a URL do Melhor Envio. Aquilo é página de painel protegida
        // por sessão: o vendedor clicava em "Baixar etiqueta" e caía no login de
        // uma conta que não é dele — aconteceu em 31/07 com a primeira venda
        // real da conta nova. O painel já tinha sido corrigido em 25/07
        // (`GET /shipping/label/:id/pdf`, com a NOSSA autenticação); o e-mail
        // ficou para trás mandando o link cru.
        //
        // O botão aponta para a página do pedido no painel, e não direto para o
        // PDF, porque o endpoint do arquivo exige Bearer — link de e-mail não
        // carrega token. Lá o vendedor já está logado e o botão baixa.
        labelUrl: `${BRAND.site}/painel/pedidos/${orderId}`,
        semAnexo: !pdf,
        comDeclaracao,
      },
      attachments: pdf
        ? [{ filename: nomeDoAnexo, content: pdf }]
        : undefined,
    });
  }

  /**
   * Baixa o PDF da etiqueta para anexar — se for mesmo um PDF.
   *
   * A URL do `print` do Melhor Envio NÃO é um arquivo: é uma página do painel,
   * protegida por sessão. Baixá-la traz o HTML do login. Sem a checagem abaixo,
   * o vendedor recebia um `etiqueta.pdf` de 20 KB que nenhum leitor abre — pior
   * que não receber anexo nenhum, porque parece problema do computador dele.
   *
   * Best-effort de propósito: sem PDF válido, o e-mail sai assim mesmo, com o
   * texto adequado.
   */
  private async baixarPdf(url: string): Promise<Buffer | null> {
    try {
      const resposta = await firstValueFrom(
        this.http.get(url, { responseType: 'arraybuffer', timeout: 20000 }),
      );
      const arquivo = Buffer.from(resposta.data as ArrayBuffer);
      // Assinatura de PDF. HTML começa com "<!DOC" e não serve.
      if (arquivo.subarray(0, 5).toString('latin1') !== '%PDF-') {
        this.logger.warn(
          `A URL da etiqueta não devolveu um PDF (${url}) — enviando sem anexo.`,
        );
        return null;
      }
      return arquivo;
    } catch (err: any) {
      this.logger.warn(
        `Não foi possível baixar o PDF da etiqueta (${url}): ${err?.message}`,
      );
      return null;
    }
  }
}
