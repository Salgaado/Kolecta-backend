// E-mail — "Não conseguimos reservar o valor do seu lance"
// Gatilho: evento `auction.bid-hold-failed`, quando o arme da retenção estoura
// o teto de tentativas (`HOLD_MAX_ATTEMPTS`).
//
// Existe porque o silêncio era metade do problema. O cron antigo tentava reter
// no cartão do líder a cada 6 horas, para sempre, e cada recusa morria no log
// do servidor: o comprador via as tentativas aparecerem e sumirem na fatura sem
// nenhuma explicação, e a plataforma não ficava sabendo de nada. Agora a
// plataforma desiste depois de poucas tentativas — e conta o que aconteceu.
//
// O tom importa: o lance dele CONTINUA VALENDO. Isto não é uma cobrança
// recusada nem um lance perdido; é a garantia que não pôde ser feita, e a única
// consequência real é ele precisar pagar dentro do prazo se arrematar.
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

export interface BidHoldFailedData {
  bidderName: string | null;
  listingId: string;
  listingTitle: string;
  amountInCents: number;
  /** Horas que o vencedor tem para pagar depois do fecho. */
  paymentDeadlineHours: number;
}

const TITLE = 'Não conseguimos reservar o valor do seu lance';

const cta = () => ({
  href: `${BRAND.site}/conta/pagamentos`,
  label: 'Conferir meu cartão',
});

const paragraphs = (data: BidHoldFailedData) => [
  `${esc(firstName(data.bidderName))}, seu lance em <strong>${esc(data.listingTitle)}</strong> <strong>continua valendo</strong> — você não perdeu nada e não precisa dar outro lance.`,
  `Quando um leilão entra na reta final, a gente reserva no cartão de quem está liderando o valor do lance, para que o pagamento saia na hora se você arrematar. No seu caso o cartão recusou essa reserva, e paramos de tentar para não ficar batendo no seu limite.`,
];

export function subject(data: BidHoldFailedData): string {
  return `Seu lance vale, mas não conseguimos reservar o valor no cartão`;
}

export function html(data: BidHoldFailedData): string {
  return renderEmail({
    preheader: `Seu lance continua valendo. Só a reserva no cartão não passou.`,
    tag: 'Modo lance',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks:
      dataBox({
        rows: [
          ['Seu lance', formatBRL(data.amountInCents)],
          ['Situação do lance', 'Continua valendo'],
        ],
      }) +
      `<div style="height:14px;"></div>` +
      alertBox(
        `<strong>Nada foi cobrado de você.</strong> Se você arrematar, terá ` +
          `${data.paymentDeadlineHours}h para escolher a entrega e pagar — e o pagamento vai ` +
          `precisar passar no cartão naquele momento. Vale conferir limite e validade antes.`,
      ),
    cta: cta(),
    footerReason: `Você recebeu este e-mail porque está com o maior lance neste leilão.`,
  });
}

export function text(data: BidHoldFailedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      `Seu lance: ${formatBRL(data.amountInCents)}`,
      `Situação do lance: continua valendo`,
      `Nada foi cobrado de você.`,
      `Se arrematar, você terá ${data.paymentDeadlineHours}h para escolher a entrega e pagar.`,
    ],
    cta: cta(),
  });
}
