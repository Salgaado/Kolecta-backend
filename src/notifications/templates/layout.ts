// Layout HTML compartilhado por todos os e-mails transacionais.
// Mantido como string TS (sem React Email) para zero overhead de build no
// backend NestJS. Pode migrar para React Email depois sem mudar os listeners.

const BRAND = {
  name: 'Kolecta',
  color: '#6d28d9', // roxo Kolecta
  bg: '#f5f3ff',
  site: process.env.FRONTEND_URL || 'https://kolecta.com.br',
  support: process.env.MAIL_REPLY_TO || 'suporte@kolecta.com.br',
};

/** Formata centavos (int) → "R$ 1.234,56" */
export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

interface LayoutOptions {
  /** Título grande no topo do card */
  heading: string;
  /** Conteúdo HTML do corpo */
  body: string;
  /** Texto do botão de ação (opcional) */
  ctaLabel?: string;
  /** URL do botão de ação (opcional) */
  ctaUrl?: string;
}

/** Envolve o corpo do e-mail no layout padrão da marca. */
export function renderLayout({
  heading,
  body,
  ctaLabel,
  ctaUrl,
}: LayoutOptions): string {
  const cta =
    ctaLabel && ctaUrl
      ? `<tr><td style="padding:8px 0 24px;">
           <a href="${ctaUrl}" style="display:inline-block;background:${BRAND.color};color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;font-size:15px;">${ctaLabel}</a>
         </td></tr>`
      : '';

  return `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:${BRAND.bg};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
          <tr><td style="background:${BRAND.color};padding:20px 32px;">
            <span style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-.5px;">${BRAND.name}</span>
          </td></tr>
          <tr><td style="padding:32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="font-size:22px;font-weight:700;padding-bottom:12px;line-height:1.3;">${heading}</td></tr>
              <tr><td style="font-size:15px;line-height:1.6;color:#374151;">${body}</td></tr>
              ${cta}
            </table>
          </td></tr>
          <tr><td style="padding:24px 32px;border-top:1px solid #f3f4f6;font-size:13px;color:#9ca3af;line-height:1.6;">
            Precisa de ajuda? Fale com a gente em
            <a href="mailto:${BRAND.support}" style="color:${BRAND.color};text-decoration:none;">${BRAND.support}</a>.<br/>
            ${BRAND.name} — marketplace de colecionáveis · <a href="${BRAND.site}" style="color:#9ca3af;">${BRAND.site}</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export { BRAND };
