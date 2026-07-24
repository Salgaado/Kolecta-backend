// E-mail — "Seu pedido saiu para entrega" (para o COMPRADOR)
// Gatilho: evento `order.shipped`, quando o vendedor marca o pedido como enviado.
// Essencial: é recibo de transação, não comunicação opcional.
import {
  renderEmail,
  renderText,
  dataBox,
  BRAND,
  esc,
  firstName,
} from './layout';

export interface OrderShippedData {
  buyerName: string | null;
  orderId: string;
  listingTitle: string;
  carrier?: string | null;
  trackingCode?: string | null;
}

const TITLE = 'Seu pedido saiu para entrega';

const cta = (orderId: string) => ({
  href: `${BRAND.site}/conta/pedidos/${orderId}`,
  label: 'Acompanhar meu pedido',
});

const paragraphs = (data: OrderShippedData) => [
  `${esc(firstName(data.buyerName))}, o vendedor postou seu pedido. Agora é com a transportadora.`,
];

export function subject(data: OrderShippedData): string {
  return `Seu pedido ${data.orderId} foi enviado`;
}

export function html(data: OrderShippedData): string {
  return renderEmail({
    preheader: data.trackingCode
      ? `Código de rastreio: ${data.trackingCode}`
      : 'O código de rastreio aparece no pedido em breve.',
    tag: 'A caminho',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks: dataBox({
      title: `Pedido ${data.orderId}`,
      rows: [
        ['Item', data.listingTitle],
        ['Transportadora', data.carrier || 'Correios'],
        ['Código de rastreio', data.trackingCode || 'Disponível em breve'],
      ],
    }),
    cta: cta(data.orderId),
    ctaCaption:
      'Quando chegar, confirme o recebimento no painel para liberar o pagamento ao vendedor.',
  });
}

export function text(data: OrderShippedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      `Pedido: ${data.orderId}`,
      `Item: ${data.listingTitle}`,
      `Transportadora: ${data.carrier || 'Correios'}`,
      `Rastreio: ${data.trackingCode || 'em breve'}`,
    ],
    cta: cta(data.orderId),
  });
}
