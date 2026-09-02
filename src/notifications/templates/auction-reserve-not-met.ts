// E-mail — "O leilão encerrou sem venda" (para quem deu o MAIOR lance)
// Gatilho: evento `auction.reserve-not-met`, no fecho do leilão.
//
// Existe porque este era o único desfecho de leilão sem aviso nenhum. Quem deu
// o maior lance abaixo do preço de reserva não arremata — não nasce pedido, não
// há frete a escolher e a retenção no cartão cai. Só que nada dizia isso a ele:
// "Meus Lances" o tratava como arrematante e a página do leilão escondia o
// aviso de reserva justamente ao encerrar. Ele ficava esperando uma entrega que
// nunca ia existir.
import {
  renderEmail,
  renderText,
  dataBox,
  alertBox,
  BRAND,
  esc,
  formatBRL,
  firstName,
} from './layout';

export interface AuctionReserveNotMetData {
  bidderName: string | null;
  listingId: string;
  listingTitle: string;
  topBidInCents: number;
  reservePriceInCents: number;
}

const TITLE = 'O leilão encerrou sem venda';

// Leva à BUSCA, não ao leilão: o leilão acabou e o anúncio foi pausado, então
// os dois só mostrariam uma porta fechada.
const cta = () => ({
  href: `${BRAND.site}/busca`,
  label: 'Ver outros leilões',
});

const paragraphs = (data: AuctionReserveNotMetData) => [
  `${esc(firstName(data.bidderName))}, o leilão de <strong>${esc(data.listingTitle)}</strong> encerrou e você tinha o maior lance — mas ele ficou abaixo do preço de reserva que o vendedor definiu, então a peça não foi vendida.`,
  `<strong>Você não precisa fazer nada.</strong> Não há compra, não há frete a escolher e nada foi cobrado de você.`,
];

export function subject(data: AuctionReserveNotMetData): string {
  return `O leilão de ${data.listingTitle} encerrou sem venda`;
}

export function html(data: AuctionReserveNotMetData): string {
  return renderEmail({
    preheader: `Seu lance foi o maior, mas não alcançou o preço de reserva. Nada foi cobrado.`,
    tag: 'Modo lance',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks:
      dataBox({
        rows: [
          ['Seu lance (o maior)', formatBRL(data.topBidInCents)],
          ['Preço de reserva', formatBRL(data.reservePriceInCents)],
        ],
      }) +
      `<div style="height:14px;"></div>` +
      alertBox(
        `A retenção no seu cartão foi <strong>liberada</strong>. Dependendo do banco, ela pode levar alguns dias para sumir da fatura — mas não vira cobrança.`,
      ),
    cta: cta(),
    footerReason: `Você recebeu este e-mail porque deu um lance neste leilão.`,
  });
}

export function text(data: AuctionReserveNotMetData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      `Seu lance (o maior): ${formatBRL(data.topBidInCents)}`,
      `Preço de reserva: ${formatBRL(data.reservePriceInCents)}`,
      `A retenção no seu cartão foi liberada — nada foi cobrado.`,
    ],
    cta: cta(),
  });
}
