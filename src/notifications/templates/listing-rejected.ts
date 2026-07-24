// E-mail #3 — "Seu anúncio precisa de ajuste" (para o VENDEDOR)
// Gatilho: evento `listing.moderated` com status de reprovação.
// O `reason` vem de `listings.rejection_reason`, persistido na moderação
// (pendência 2.1) — é a parte útil do e-mail.
// Conteúdo portado de `emails/templates.mjs` → anuncioRejeitado().
import {
  renderEmail,
  renderText,
  alertBox,
  COLORS,
  BRAND,
  esc,
  firstName,
} from './layout';

export interface ListingRejectedData {
  sellerName: string | null;
  listingId: string;
  listingTitle: string;
  reason?: string | null;
}

const TITLE = 'Seu anúncio precisa de ajuste';

const cta = (listingId: string) => ({
  href: `${BRAND.site}/painel/anuncios/${listingId}/editar`,
  label: 'Corrigir e reenviar',
});

const paragraphs = (data: ListingRejectedData) => [
  `${esc(firstName(data.sellerName))}, o anúncio <strong>${esc(data.listingTitle)}</strong> não passou na moderação desta vez.`,
  `Isso não é bloqueio de conta nem advertência. É só um ajuste no anúncio, e depois de corrigir ele volta para a fila normalmente.`,
];

export function subject(data: ListingRejectedData): string {
  return `${data.listingTitle} precisa de ajuste`;
}

export function html(data: ListingRejectedData): string {
  return renderEmail({
    preheader: data.reason || 'Ajuste o anúncio e reenvie para a moderação.',
    tag: 'Ajuste necessário',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks: data.reason
      ? alertBox(
          `<strong style="color:${COLORS.red};">Motivo:</strong> ${esc(data.reason)}`,
          { color: COLORS.red },
        )
      : '',
    cta: cta(data.listingId),
  });
}

export function text(data: ListingRejectedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: data.reason ? [`Motivo: ${data.reason}`] : [],
    cta: cta(data.listingId),
  });
}
