// E-mail — "Você arrematou" (para o VENCEDOR do leilão)
// Gatilho: evento `auction.won`, no fechamento do leilão.
// Essencial: é o aviso de que existe um pedido no nome dele.
//
// Três desfechos, e o texto muda conforme:
//  - precisa escolher o frete → é o caminho normal desde que o fecho parou de
//    capturar: o lance cobre só a peça, e o vencedor escolhe como receber. É o
//    mais urgente, porque sem a escolha nada é cobrado e o prazo corre.
//  - só falta pagar           → pedido 'pending_payment' com entrega escolhida
//  - já pago                  → nada a fazer além de aguardar o envio
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
  /** true quando o pedido ainda não foi cobrado. */
  needsPayment: boolean;
  /** true quando falta o vencedor escolher frete ou retirada. */
  needsShippingChoice?: boolean;
  paymentDeadlineHours?: number;
}

const TITLE = 'Você arrematou!';

const cta = (data: AuctionWonData) => ({
  href: `${BRAND.site}/conta/pedidos/${data.orderId}`,
  label: data.needsShippingChoice
    ? 'Escolher frete e pagar'
    : data.needsPayment
      ? 'Pagar agora'
      : 'Ver meu pedido',
});

const paragraphs = (data: AuctionWonData) => [
  `${esc(firstName(data.winnerName))}, o leilão de <strong style="color:${COLORS.gold};">${esc(data.listingTitle)}</strong> encerrou e o lance vencedor foi o seu.`,
  data.needsShippingChoice
    ? `Falta escolher como quer receber a peça. O valor do frete entra no total do arremate, e a cobrança sai de uma vez só — o valor do lance segue retido no seu cartão até lá.`
    : data.needsPayment
      ? `Não conseguimos capturar a retenção do seu cartão, então o pedido está aguardando pagamento.`
      : `A cobrança já foi feita no cartão que garantiu o seu lance. O vendedor foi avisado e vai preparar o envio.`,
];

/** O prazo vale para os dois estados pendentes: escolher frete é o que destrava a cobrança. */
const pendente = (data: AuctionWonData) =>
  data.needsPayment || data.needsShippingChoice;

export function subject(data: AuctionWonData): string {
  return `Você arrematou ${data.listingTitle}`;
}

export function html(data: AuctionWonData): string {
  const hours = data.paymentDeadlineHours ?? 48;
  return renderEmail({
    preheader: data.needsShippingChoice
      ? `Lance vencedor: ${formatBRL(data.finalAmountInCents)}. Escolha o frete em até ${hours}h.`
      : data.needsPayment
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
        highlight: [
          data.needsShippingChoice ? 'Lance vencedor' : 'Valor final',
          formatBRL(data.finalAmountInCents),
        ],
      }) +
      (pendente(data)
        ? `<div style="height:14px;"></div>` +
          alertBox(
            data.needsShippingChoice
              ? `Escolha o frete em até <strong style="color:${COLORS.gold};">${hours} horas</strong>. Passado o prazo, a peça volta para o vendedor e a retenção do seu cartão é liberada.`
              : `Pague em até <strong style="color:${COLORS.gold};">${hours} horas</strong>. Passado o prazo, a peça volta para o vendedor.`,
            { color: COLORS.red },
          )
        : ''),
    cta: cta(data),
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
      `${data.needsShippingChoice ? 'Lance vencedor' : 'Valor final'}: ${formatBRL(data.finalAmountInCents)}`,
      ...(data.needsShippingChoice
        ? [`Falta escolher o frete — o valor entra no total.`]
        : []),
      ...(pendente(data) ? [`Prazo: ${hours} horas`] : []),
    ],
    cta: cta(data),
  });
}
