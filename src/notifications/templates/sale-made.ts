// E-mail — "Você fez uma venda!" (para o VENDEDOR)
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

export interface SaleMadeData {
  sellerName: string | null;
  orderId: string;
  listingTitle: string;
  totalInCents: number;
}

const TITLE = 'Você fez uma venda!';
const PRAZO_ENVIO_DIAS = 2;

const cta = (orderId: string) => ({
  href: `${BRAND.site}/painel/pedidos/${orderId}`,
  label: 'Gerenciar venda',
});

const paragraphs = (data: SaleMadeData) => [
  `${esc(firstName(data.sellerName))}, o pagamento foi confirmado e o pedido já é seu para preparar.`,
  `Poste o pacote em até <strong>${PRAZO_ENVIO_DIAS} dias úteis</strong> e gere a etiqueta pelo painel — o valor fica retido e é liberado depois da entrega.`,
];

export function subject(data: SaleMadeData): string {
  return `Você vendeu: pedido ${data.orderId}`;
}

export function html(data: SaleMadeData): string {
  return renderEmail({
    preheader: `${data.listingTitle} — ${formatBRL(data.totalInCents)}`,
    tag: 'Nova venda',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks: dataBox({
      title: 'Detalhes da venda',
      rows: [
        ['Pedido', data.orderId],
        ['Item', data.listingTitle],
      ],
      highlight: ['Total', formatBRL(data.totalInCents)],
    }),
    cta: cta(data.orderId),
  });
}

export function text(data: SaleMadeData): string {
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
