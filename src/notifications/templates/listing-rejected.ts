// E-mail #3 — "Seu anúncio precisa de ajuste" (para o VENDEDOR)
// Gatilho: evento `listing.moderated` com status de reprovação.
// O `motivo` vem de `listings.rejection_reason`, persistido na moderação
// (pendência 2.1) — é a parte útil do e-mail. Sem ele o vendedor não sabe o
// que corrigir, então o template deixa claro quando o motivo não veio.
// Conteúdo portado de `emails/templates.mjs` → anuncioRejeitado().
import { renderLayout, BRAND, esc, firstName } from './layout';

export interface ListingRejectedData {
  sellerName: string | null;
  listingId: string;
  listingTitle: string;
  reason?: string | null;
}

export function subject(data: ListingRejectedData): string {
  return `${data.listingTitle} precisa de ajuste`;
}

export function html(data: ListingRejectedData): string {
  const n = firstName(data.sellerName);
  const greeting = n ? `${esc(n)}, o` : 'O';

  // Caixa de destaque com o motivo. Só aparece quando há motivo de verdade.
  const reasonBox = data.reason
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border-left:4px solid #dc2626;border-radius:8px;margin:4px 0 16px;">
         <tr><td style="padding:14px 18px;">
           <p style="margin:0 0 4px;font-weight:600;color:#dc2626;">Motivo</p>
           <p style="margin:0;color:#374151;">${esc(data.reason)}</p>
         </td></tr>
       </table>`
    : '';

  return renderLayout({
    heading: '⚠️ Seu anúncio precisa de ajuste',
    body: `
      <p style="margin:0 0 12px;">${greeting} anúncio <strong>${esc(data.listingTitle)}</strong> não passou na moderação desta vez.</p>
      ${reasonBox}
      <p style="margin:0 0 12px;">Isso não é bloqueio de conta nem advertência. É só um ajuste no anúncio — depois de corrigir, ele volta para a fila normalmente.</p>
    `,
    ctaLabel: 'Corrigir e reenviar',
    ctaUrl: `${BRAND.site}/painel/anuncios/${data.listingId}/editar`,
  });
}
