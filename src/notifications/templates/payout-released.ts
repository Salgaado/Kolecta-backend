// E-mail — "Repasse liberado" (para o VENDEDOR)
// Gatilho: evento `payout.released`, quando o saldo retido vira disponível
// (comprador confirmou o recebimento, ou passaram as 48h automáticas).
import {
  renderEmail,
  renderText,
  dataBox,
  BRAND,
  esc,
  formatBRL,
  firstName,
} from './layout';

export interface PayoutReleasedData {
  sellerName: string | null;
  amountInCents: number;
  orderId?: string | null;
}

const TITLE = 'Repasse liberado';

const CTA = {
  href: `${BRAND.site}/painel/financeiro`,
  label: 'Ver meu financeiro',
};

const paragraphs = (data: PayoutReleasedData) => [
  `${esc(firstName(data.sellerName))}, liberamos ${data.orderId ? `o repasse do pedido ${esc(data.orderId)}` : 'um repasse'}. O valor já está disponível no seu saldo para saque.`,
];

export function subject(data: PayoutReleasedData): string {
  return `Repasse de ${formatBRL(data.amountInCents)} liberado`;
}

export function html(data: PayoutReleasedData): string {
  return renderEmail({
    preheader: `${formatBRL(data.amountInCents)} disponível para saque.`,
    tag: 'Financeiro',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks: dataBox({
      rows: data.orderId ? [['Pedido', data.orderId]] : [],
      highlight: ['Valor liberado', formatBRL(data.amountInCents)],
    }),
    cta: CTA,
  });
}

export function text(data: PayoutReleasedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      `Valor: ${formatBRL(data.amountInCents)}`,
      ...(data.orderId ? [`Pedido: ${data.orderId}`] : []),
    ],
    cta: CTA,
  });
}
