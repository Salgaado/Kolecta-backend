// E-mail — "Cobriram o seu lance" (para quem foi SUPERADO)
// Gatilho: evento `auction.bid.placed`, para o líder anterior.
// A pré-autorização dele no cartão é cancelada junto — o valor deixa de ficar
// retido, então o e-mail avisa que ele precisa dar um novo lance para voltar.
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

export interface BidOutbidData {
  bidderName: string | null;
  auctionId: string;
  listingTitle: string;
  yourBidInCents: number;
  currentBidInCents: number;
  /** Texto legível do prazo ("2 dias", "5 horas"), ou null se já encerrando. */
  endsIn?: string | null;
}

const TITLE = 'Cobriram o seu lance';

const cta = (auctionId: string) => ({
  href: `${BRAND.site}/modo-lance/${auctionId}`,
  label: 'Dar um novo lance',
});

const paragraphs = (data: BidOutbidData) => [
  `${esc(firstName(data.bidderName))}, alguém deu um lance maior em <strong>${esc(data.listingTitle)}</strong>. Se ainda quiser a peça, dá tempo de voltar.`,
  `A retenção no seu cartão foi cancelada — nada foi cobrado.`,
];

export function subject(data: BidOutbidData): string {
  return `Cobriram seu lance em ${data.listingTitle}`;
}

export function html(data: BidOutbidData): string {
  return renderEmail({
    preheader: `Lance atual: ${formatBRL(data.currentBidInCents)}. Ainda dá tempo.`,
    tag: 'Modo lance',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks:
      dataBox({
        rows: [['Seu lance', formatBRL(data.yourBidInCents)]],
        highlight: ['Lance atual', formatBRL(data.currentBidInCents)],
      }) +
      (data.endsIn
        ? `<div style="height:14px;"></div>` +
          alertBox(
            `O leilão encerra em <strong style="color:${COLORS.gold};">${esc(data.endsIn)}</strong>.`,
          )
        : ''),
    cta: cta(data.auctionId),
  });
}

export function text(data: BidOutbidData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      `Seu lance: ${formatBRL(data.yourBidInCents)}`,
      `Lance atual: ${formatBRL(data.currentBidInCents)}`,
      ...(data.endsIn ? [`Encerra em: ${data.endsIn}`] : []),
    ],
    cta: cta(data.auctionId),
  });
}
