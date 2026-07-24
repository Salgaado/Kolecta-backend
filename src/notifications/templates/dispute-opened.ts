// E-mail — "Abriram uma disputa" (para o VENDEDOR)
// Gatilho: evento `dispute.opened`, quando o comprador abre a disputa.
//
// Nota de rota: não existe página de disputa do vendedor no front (só
// `/conta/disputas` do comprador e `/admin/disputas`). O CTA aponta para o
// pedido, que é a tela que o vendedor tem hoje.
import {
  renderEmail,
  renderText,
  alertBox,
  COLORS,
  BRAND,
  esc,
  firstName,
} from './layout';

export interface DisputeOpenedData {
  sellerName: string | null;
  orderId: string;
  listingTitle?: string | null;
  reason?: string | null;
  responseDeadlineDays?: number;
}

const TITLE = 'Abriram uma disputa';

const cta = (orderId: string) => ({
  href: `${BRAND.site}/painel/pedidos/${orderId}`,
  label: 'Ver o pedido',
});

const paragraphs = (data: DisputeOpenedData) => [
  `${esc(firstName(data.sellerName))}, o comprador abriu uma disputa no pedido ${esc(data.orderId)}${
    data.listingTitle ? ` (${esc(data.listingTitle)})` : ''
  }. O repasse fica retido até isso ser resolvido.`,
  `Responda com sua versão e reúna o que tiver: comprovante de postagem, fotos da peça antes do envio, conversa com o comprador.`,
];

export function subject(data: DisputeOpenedData): string {
  return `Disputa aberta no pedido ${data.orderId}`;
}

export function html(data: DisputeOpenedData): string {
  const days = data.responseDeadlineDays ?? 3;
  return renderEmail({
    preheader: `Responda em até ${days} dias.`,
    tag: 'Disputa',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks:
      (data.reason
        ? alertBox(
            `<strong style="color:${COLORS.muted};">Motivo informado:</strong> ${esc(data.reason)}`,
          ) + `<div style="height:14px;"></div>`
        : '') +
      alertBox(
        `Você tem <strong style="color:${COLORS.gold};">${days} dias</strong> para responder. Sem resposta, a disputa é decidida com o que estiver registrado.`,
        { color: COLORS.red },
      ),
    cta: cta(data.orderId),
  });
}

export function text(data: DisputeOpenedData): string {
  const days = data.responseDeadlineDays ?? 3;
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      ...(data.reason ? [`Motivo informado: ${data.reason}`] : []),
      `Prazo de resposta: ${days} dias`,
    ],
    cta: cta(data.orderId),
  });
}
