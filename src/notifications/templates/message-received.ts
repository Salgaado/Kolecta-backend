// E-mail — "Nova mensagem" (para o DESTINATÁRIO da conversa)
// Gatilho: evento `message.received`, em MessagesService.sendMessage.
//
// Nota de rota: as duas pontas da conversa têm caixas de entrada DIFERENTES —
// `/conta/mensagens` para quem comprou e `/painel/mensagens` para quem vendeu.
// O CTA apontava para a do comprador em todo caso, então o vendedor recebia
// "você tem uma mensagem", clicava em Responder e caía na caixa errada, onde a
// conversa dele aparece com os papéis invertidos. Os dois únicos avisos que a
// plataforma chegou a mandar (25/07 e 31/07) foram para vendedores, e as duas
// mensagens seguiam não lidas.
//
// Nenhuma das duas telas tem rota por conversa (`.../mensagens/:id`), então o
// CTA aponta para a lista. A do comprador aceita `?conv=`; a do vendedor não.
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
  /**
   * O destinatário é o VENDEDOR desta conversa? Decide para qual caixa de
   * entrada o botão leva. Ausente = comprador, que era o comportamento antigo.
   */
  recipientIsSeller?: boolean;
}

const TITLE = 'Nova mensagem';

/** Cada lado tem a sua caixa; mandar para a errada é o mesmo que não mandar. */
function ctaDe(data: MessageReceivedData) {
  return {
    href: data.recipientIsSeller
      ? `${BRAND.site}/painel/mensagens`
      : `${BRAND.site}/conta/mensagens`,
    label: 'Responder',
  };
}

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
    cta: ctaDe(data),
    // A legenda antiga falava de "reputação de vendedor" para os dois lados,
    // inclusive para o comprador, que não tem reputação de vendedor nenhuma.
    ctaCaption: data.recipientIsSeller
      ? 'Responder rápido melhora sua reputação de vendedor.'
      : 'O vendedor é avisado assim que você responder.',
  });
}

export function text(data: MessageReceivedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [`"${data.excerpt}"`],
    cta: ctaDe(data),
  });
}
