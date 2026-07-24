// E-mail — "Pagamento confirmado" (para o COMPRADOR)
// Gatilho: evento `order.paid`.
import {
  renderEmail,
  renderText,
  dataBox,
  BRAND,
  esc,
  formatBRL,
  firstName,
} from './layout';

export interface OrderConfirmedData {
  buyerName: string | null;
  orderId: string;
  listingTitle: string;
  totalInCents: number;
}

const TITLE = 'Pagamento confirmado';

const cta = (orderId: string) => ({
  href: `${BRAND.site}/conta/pedidos/${orderId}`,
  label: 'Ver meu pedido',
});

const paragraphs = (data: OrderConfirmedData) => [
  `${esc(firstName(data.buyerName))}, recebemos seu pagamento. O vendedor já foi avisado e vai preparar o envio.`,
  `Você recebe um novo aviso assim que o pacote for postado, com o código de rastreio.`,
];

export function subject(data: OrderConfirmedData): string {
  return `Pedido ${data.orderId} confirmado`;
}

export function html(data: OrderConfirmedData): string {
  return renderEmail({
    preheader: `Seu pagamento de ${formatBRL(data.totalInCents)} foi confirmado.`,
    tag: 'Pedido confirmado',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks: dataBox({
      title: 'Resumo do pedido',
      rows: [
        ['Pedido', data.orderId],
        ['Item', data.listingTitle],
      ],
      highlight: ['Total', formatBRL(data.totalInCents)],
    }),
    cta: cta(data.orderId),
  });
}

export function text(data: OrderConfirmedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      `Pedido: ${data.orderId}`,
      `Item: ${data.listingTitle}`,
      `Total: ${formatBRL(data.totalInCents)}`,
    ],
    cta: cta(data.orderId),
  });
}
