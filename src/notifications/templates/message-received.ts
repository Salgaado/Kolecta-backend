// E-mail — "Nova mensagem" (para o DESTINATÁRIO da conversa)
// Gatilho: evento `message.received`, em MessagesService.sendMessage.
//
// Nota de rota: o front tem `/conta/mensagens` (lista), mas não uma rota por
// conversa (`/conta/mensagens/:id`). O CTA aponta para a lista até existir.
import {
  renderEmail,
  renderText,
  alertBox,
  COLORS,
  BRAND,
  esc,
  firstName,
} from './layout';

export interface MessageReceivedData {
  recipientName: string | null;
  senderName: string | null;
  excerpt: string;
  listingTitle?: string | null;
}

const TITLE = 'Nova mensagem';

const CTA = { href: `${BRAND.site}/conta/mensagens`, label: 'Responder' };

const paragraphs = (data: MessageReceivedData) => [
  `${esc(firstName(data.recipientName))}, <strong>${esc(data.senderName ?? 'Alguém')}</strong> te mandou uma mensagem${
    data.listingTitle ? ` sobre <strong>${esc(data.listingTitle)}</strong>` : ''
  }.`,
];

export function subject(data: MessageReceivedData): string {
  return `${data.senderName ?? 'Alguém'} te mandou uma mensagem`;
}

export function html(data: MessageReceivedData): string {
  return renderEmail({
    preheader: data.excerpt,
    tag: 'Mensagem',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks: alertBox(
      `<em style="color:${COLORS.muted};">"${esc(data.excerpt)}"</em>`,
    ),
    cta: CTA,
    ctaCaption: 'Responder rápido melhora sua reputação de vendedor.',
  });
}

export function text(data: MessageReceivedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [`"${data.excerpt}"`],
    cta: CTA,
  });
}
