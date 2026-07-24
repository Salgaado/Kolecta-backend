// E-mail #2 — "Seu anúncio foi aprovado" (para o VENDEDOR)
// Gatilho: evento `listing.moderated` com status `active` — só quando a mudança
// vem de uma AÇÃO DE ADMIN (moderatorId presente). Publicação feita pelo próprio
// vendedor não dispara: ninguém precisa ser avisado do que acabou de fazer.
// Conteúdo portado de `emails/templates.mjs` → anuncioAprovado().
import { renderEmail, renderText, COLORS, BRAND, esc, firstName } from './layout';

export interface ListingApprovedData {
  sellerName: string | null;
  listingId: string;
  listingTitle: string;
}

const TITLE = 'Seu anúncio foi aprovado';

const cta = (listingId: string) => ({
  href: `${BRAND.site}/produto/${listingId}`,
  label: 'Ver meu anúncio no ar',
});

const paragraphs = (data: ListingApprovedData) => [
  `${esc(firstName(data.sellerName))}, o anúncio <strong style="color:${COLORS.gold};">${esc(data.listingTitle)}</strong> passou pela moderação e já está visível para todo mundo na Kolecta.`,
  `A partir de agora ele aparece na busca, na categoria e no seu perfil de vendedor.`,
];

export function subject(data: ListingApprovedData): string {
  return `${data.listingTitle} foi aprovado`;
}

export function html(data: ListingApprovedData): string {
  return renderEmail({
    preheader: `${data.listingTitle} já está visível na Kolecta.`,
    tag: 'Anúncio aprovado',
    title: TITLE,
    paragraphs: paragraphs(data),
    cta: cta(data.listingId),
    ctaCaption: 'Dica: anúncio com 3 fotos ou mais vende bem mais rápido.',
  });
}

export function text(data: ListingApprovedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    cta: cta(data.listingId),
  });
}
