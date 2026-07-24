// E-mail — "Novo lance no seu leilão" (para o VENDEDOR)
// Gatilho: evento `auction.bid.placed`.
import {
  renderEmail,
  renderText,
  dataBox,
  BRAND,
  esc,
  formatBRL,
  firstName,
} from './layout';

export interface BidReceivedData {
  sellerName: string | null;
  auctionId: string;
  listingTitle: string;
  amountInCents: number;
  totalBids: number;
}

const TITLE = 'Novo lance no seu leilão';

const cta = (auctionId: string) => ({
  href: `${BRAND.site}/modo-lance/${auctionId}`,
  label: 'Acompanhar o leilão',
});

const paragraphs = (data: BidReceivedData) => [
  `${esc(firstName(data.sellerName))}, alguém deu lance em <strong>${esc(data.listingTitle)}</strong>.`,
];

export function subject(data: BidReceivedData): string {
  return `Lance de ${formatBRL(data.amountInCents)} em ${data.listingTitle}`;
}

export function html(data: BidReceivedData): string {
  return renderEmail({
    preheader: `Lance atual: ${formatBRL(data.amountInCents)}`,
    tag: 'Modo lance',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks: dataBox({
      title: 'Situação agora',
      rows: [['Lances recebidos', String(data.totalBids)]],
      highlight: ['Lance atual', formatBRL(data.amountInCents)],
    }),
    cta: cta(data.auctionId),
  });
}

export function text(data: BidReceivedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      `Lance atual: ${formatBRL(data.amountInCents)}`,
      `Lances recebidos: ${data.totalBids}`,
    ],
    cta: cta(data.auctionId),
  });
}
