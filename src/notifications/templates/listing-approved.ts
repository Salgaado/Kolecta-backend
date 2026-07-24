// E-mail #2 — "Seu anúncio foi aprovado" (para o VENDEDOR)
// Gatilho: evento `listing.moderated` com status `active` — só quando a mudança
// vem de uma AÇÃO DE ADMIN (moderatorId presente). Publicação feita pelo próprio
// vendedor não dispara: ninguém precisa ser avisado do que acabou de fazer.
// Conteúdo portado de `emails/templates.mjs` → anuncioAprovado().
import { renderLayout, BRAND, esc, firstName } from './layout';

export interface ListingApprovedData {
  sellerName: string | null;
  listingId: string;
  listingTitle: string;
}

export function subject(data: ListingApprovedData): string {
  return `${data.listingTitle} foi aprovado`;
}

export function html(data: ListingApprovedData): string {
  const n = firstName(data.sellerName);
  const greeting = n ? `${esc(n)}, o` : 'O';

  return renderLayout({
    heading: '✅ Seu anúncio foi aprovado!',
    body: `
      <p style="margin:0 0 12px;">${greeting} anúncio <strong>${esc(data.listingTitle)}</strong> passou pela moderação e já está visível para todo mundo na Kolecta.</p>
      <p style="margin:0 0 12px;">A partir de agora ele aparece na busca, na categoria e no seu perfil de vendedor.</p>
      <p style="margin:16px 0 0;color:#6b7280;font-size:14px;">Dica: anúncio com 3 fotos ou mais vende bem mais rápido.</p>
    `,
    ctaLabel: 'Ver meu anúncio no ar',
    ctaUrl: `${BRAND.site}/produto/${data.listingId}`,
  });
}
