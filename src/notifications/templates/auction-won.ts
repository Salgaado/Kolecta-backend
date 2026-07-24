// E-mail — "Você arrematou" (para o VENCEDOR do leilão)
// Gatilho: evento `auction.won`, no fechamento do leilão.
// Essencial: é o aviso de que existe um pedido no nome dele.
//
// Dois desfechos possíveis no fechamento, e o texto muda conforme:
//  - captura da pré-auth OK   → pedido já PAGO, nada a fazer além de aguardar
//  - captura falhou           → pedido 'pending_payment', com prazo para pagar
import {
  renderEmail,
  renderText,
  dataBox,
  alertBox,
  COLORS,
  BRAND,
  esc,
  formatBRL,
  firstName,
} from './layout';

export interface AuctionWonData {
  winnerName: string | null;
  orderId: string;
  listingTitle: string;
  finalAmountInCents: number;
  /** true quando a captura falhou e o vencedor precisa pagar. */
  needsPayment: boolean;
  paymentDeadlineHours?: number;
}

const TITLE = 'Você arrematou!';

const cta = (orderId: string, needsPayment: boolean) => ({
  href: `${BRAND.site}/conta/pedidos/${orderId}`,
  label: needsPayment ? 'Pagar agora' : 'Ver meu pedido',
});

const paragraphs = (data: AuctionWonData) => [
  `${esc(firstName(data.winnerName))}, o leilão de <strong style="color:${COLORS.gold};">${esc(data.listingTitle)}</strong> encerrou e o lance vencedor foi o seu.`,
  data.needsPayment
    ? `Não conseguimos capturar a retenção do seu cartão, então o pedido está aguardando pagamento.`
    : `A cobrança já foi feita no cartão que garantiu o seu lance. O vendedor foi avisado e vai preparar o envio.`,
];

export function subject(data: AuctionWonData): string {
  return `Você arrematou ${data.listingTitle}`;
}

export function html(data: AuctionWonData): string {
  const hours = data.paymentDeadlineHours ?? 48;
  return renderEmail({
    preheader: data.needsPayment
      ? `Lance vencedor: ${formatBRL(data.finalAmountInCents)}. Pague em até ${hours}h.`
      : `Lance vencedor: ${formatBRL(data.finalAmountInCents)}. Pagamento confirmado.`,
    tag: 'Arremate',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks:
      dataBox({
        rows: [
          ['Item', data.listingTitle],
          ['Pedido', data.orderId],
        ],
        highlight: ['Valor final', formatBRL(data.finalAmountInCents)],
      }) +
      (data.needsPayment
        ? `<div style="height:14px;"></div>` +
          alertBox(
            `Pague em até <strong style="color:${COLORS.gold};">${hours} horas</strong>. Passado o prazo, a peça volta para o vendedor.`,
            { color: COLORS.red },
          )
        : ''),
    cta: cta(data.orderId, data.needsPayment),
  });
}

export function text(data: AuctionWonData): string {
  const hours = data.paymentDeadlineHours ?? 48;
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      `Item: ${data.listingTitle}`,
      `Pedido: ${data.orderId}`,
      `Valor final: ${formatBRL(data.finalAmountInCents)}`,
      ...(data.needsPayment ? [`Prazo de pagamento: ${hours} horas`] : []),
    ],
    cta: cta(data.orderId, data.needsPayment),
  });
}
