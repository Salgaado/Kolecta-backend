// ── Layout base dos e-mails da Kolecta ────────────────────────────────────────
//
// Porte TypeScript de `kolecta-the-collector-s-hub/emails/layout.mjs`, que é a
// identidade visual oficial: tema escuro (carbon sobre dark) com dourado, a
// mesma paleta do site (`--kolecta-gold: 48 100% 50%` = #FFD700).
//
// HTML de e-mail não é HTML de site. Nada de flexbox, grid, <style> externo ou
// classe CSS: Gmail, Outlook e Apple Mail descartam boa parte disso. Tudo aqui
// é tabela aninhada com estilo inline, largura travada em 600px, que é o que
// renderiza igual em todo lugar.

export const COLORS = {
  gold: '#FFD700',
  dark: '#101218', // kolecta-dark
  carbon: '#15171E', // kolecta-carbon
  border: '#2A2D38',
  text: '#E8E9ED',
  muted: '#9A9DA8',
  faint: '#6A6E7C',
  green: '#4ADE80',
  red: '#F87171',
};

// Domínio público da marca. E-mail é lido FORA do nosso ambiente: um link para
// localhost (valor de FRONTEND_URL em dev) é inútil para quem recebe, e a logo
// simplesmente não carrega. Por isso o fallback é sempre o domínio público, e
// FRONTEND_URL só é aceito quando aponta para um host de verdade.
const PUBLIC_SITE = 'https://kolecta.com.br';
const configuredSite = process.env.MAIL_SITE_URL || process.env.FRONTEND_URL;
const SITE =
  configuredSite && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(configuredSite)
    ? configuredSite.replace(/\/$/, '')
    : PUBLIC_SITE;

// A logo mora no domínio público sempre: 360x62 (retina de 180x31).
const LOGO = `${PUBLIC_SITE}/emails/kolecta-logo.png`;
const FONT = 'Arial,Helvetica,sans-serif';

export const BRAND = {
  name: 'Kolecta',
  site: SITE,
  support: process.env.MAIL_REPLY_TO || 'contato@kolecta.com.br',
};

/**
 * Escapa HTML. Obrigatório em qualquer dado vindo do usuário (título de anúncio,
 * nome, motivo de reprovação) — sem isso, um título com `<script>` ou aspas
 * quebra o corpo do e-mail e vira vetor de injeção.
 */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Formata centavos (int) → "R$ 1.234,56" */
export function formatBRL(cents: number): string {
  const n = Number(cents) / 100;
  if (!Number.isFinite(n)) return 'R$ 0,00';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Primeiro nome, com a capitalização arrumada.
 * O banco tem de tudo: "FERNANDO NASCIMENTO", "wilbur da silva" e nomes de loja
 * como "StopGames". Só mexemos quando está todo em maiúscula ou todo em
 * minúscula; se tem maiúscula no meio, é grafia da marca e fica como está.
 */
export function firstName(name: string | null | undefined): string {
  const raw = String(name ?? '').trim().split(/\s+/)[0] || 'colecionador';
  const needsFix = raw === raw.toUpperCase() || raw === raw.toLowerCase();
  if (!needsFix) return raw;
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

// ── Peças ─────────────────────────────────────────────────────────────────────

/** Botão. Vai em tabela porque o Outlook ignora padding em <a>. */
export function button(
  href: string,
  label: string,
  { color = COLORS.gold, textColor = COLORS.dark } = {},
): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
    <tr>
      <td align="center" bgcolor="${color}" style="border-radius:8px;">
        <a href="${esc(href)}" target="_blank"
           style="display:inline-block;padding:16px 34px;font-family:${FONT};
                  font-size:16px;font-weight:bold;color:${textColor};text-decoration:none;
                  border-radius:8px;letter-spacing:0.3px;">${esc(label)}</a>
      </td>
    </tr>
  </table>`;
}

/** Item de lista com o check dourado. Aceita HTML no texto. */
function listItem(html: string): string {
  return `
  <tr>
    <td width="26" valign="top" style="padding:0 0 12px 0;font-family:${FONT};
        font-size:15px;line-height:22px;color:${COLORS.gold};">&#10003;</td>
    <td valign="top" style="padding:0 0 12px 0;font-family:${FONT};
        font-size:15px;line-height:22px;color:${COLORS.text};">${html}</td>
  </tr>`;
}

/** Caixa escura com título e lista de checks. */
export function checklistBox({
  title,
  items,
}: {
  title?: string;
  items: string[];
}): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:${COLORS.dark};border:1px solid ${COLORS.border};border-radius:10px;">
    <tr>
      <td style="padding:22px 22px 10px 22px;">
        ${title ? `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.muted};">${esc(title)}</p>` : ''}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${items.map(listItem).join('')}
        </table>
      </td>
    </tr>
  </table>`;
}

/** Caixa de dados em duas colunas, tipo resumo de pedido. */
export function dataBox({
  title,
  rows,
  highlight,
}: {
  title?: string;
  rows: Array<[string, string]>;
  highlight?: [string, string];
}): string {
  const body = rows
    .map(
      ([label, value]) => `
    <tr>
      <td style="padding:0 0 10px 0;font-family:${FONT};font-size:14px;line-height:20px;
                 color:${COLORS.muted};">${esc(label)}</td>
      <td align="right" style="padding:0 0 10px 0;font-family:${FONT};font-size:14px;
                 line-height:20px;color:${COLORS.text};">${esc(value)}</td>
    </tr>`,
    )
    .join('');

  const footer = highlight
    ? `
    <tr>
      <td style="padding:14px 0 0 0;border-top:1px solid ${COLORS.border};font-family:${FONT};
                 font-size:15px;font-weight:bold;color:${COLORS.text};">${esc(highlight[0])}</td>
      <td align="right" style="padding:14px 0 0 0;border-top:1px solid ${COLORS.border};
                 font-family:${FONT};font-size:18px;font-weight:bold;color:${COLORS.gold};">${esc(highlight[1])}</td>
    </tr>`
    : '';

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:${COLORS.dark};border:1px solid ${COLORS.border};border-radius:10px;">
    <tr>
      <td style="padding:22px;">
        ${title ? `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.muted};">${esc(title)}</p>` : ''}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${body}${footer}
        </table>
      </td>
    </tr>
  </table>`;
}

/** Aviso destacado, para prazo curto ou algo que exige ação. */
export function alertBox(
  html: string,
  { color = COLORS.gold } = {},
): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:${COLORS.dark};border-left:3px solid ${color};border-radius:6px;">
    <tr>
      <td style="padding:16px 18px;font-family:${FONT};font-size:14px;line-height:21px;
                 color:${COLORS.text};">${html}</td>
    </tr>
  </table>`;
}

// ── Casca ─────────────────────────────────────────────────────────────────────

export interface EmailShell {
  /** Trecho que aparece na lista de e-mails antes de abrir. */
  preheader: string;
  /** Rótulo pequeno em dourado acima do título. */
  tag?: string;
  /** O H1. */
  title: string;
  /** Aceitam HTML inline (strong, a) — escape o que vier do usuário. */
  paragraphs?: string[];
  /** HTML extra: dataBox, checklistBox, alertBox. */
  blocks?: string;
  cta?: { href: string; label: string };
  ctaCaption?: string;
  /** Por que a pessoa está recebendo isto. */
  footerReason?: string;
}

/** Monta o e-mail inteiro. */
export function renderEmail({
  preheader,
  tag,
  title,
  paragraphs = [],
  blocks = '',
  cta,
  ctaCaption,
  footerReason,
}: EmailShell): string {
  const reason =
    footerReason ??
    `Você recebeu este e-mail porque tem uma conta em <a href="${SITE}" style="color:${COLORS.muted};text-decoration:underline;">kolecta.com.br</a>.`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.dark};">

<div style="display:none;font-size:1px;color:${COLORS.dark};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
  ${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.dark};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:100%;max-width:600px;">

        <!-- Logo. O alt vai estilizado porque muitos clientes bloqueiam imagem
             por padrão: se a arte não carregar, ainda aparece KOLECTA em dourado
             no lugar de um ícone quebrado. -->
        <tr>
          <td align="center" style="padding:0 0 28px 0;">
            <a href="${SITE}" target="_blank" style="text-decoration:none;">
              <img src="${LOGO}" width="180" height="31" alt="KOLECTA"
                   style="display:block;width:180px;max-width:60%;height:auto;border:0;
                          font-family:${FONT};font-size:26px;font-weight:bold;
                          letter-spacing:2px;color:${COLORS.gold};text-decoration:none;">
            </a>
          </td>
        </tr>

        <tr>
          <td style="background-color:${COLORS.carbon};border:1px solid ${COLORS.border};border-radius:14px;">

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="height:4px;line-height:4px;font-size:0;background-color:${COLORS.gold};
                             border-radius:14px 14px 0 0;">&nbsp;</td></tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:36px 32px 8px 32px;">
                  ${tag ? `<p style="margin:0 0 10px 0;font-family:${FONT};font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${COLORS.gold};">${esc(tag)}</p>` : ''}
                  <h1 style="margin:0 0 20px 0;font-family:${FONT};font-size:28px;line-height:34px;
                             font-weight:bold;color:#FFFFFF;">${esc(title)}</h1>
                  ${paragraphs
                    .map(
                      (p) => `
                  <p style="margin:0 0 18px 0;font-family:${FONT};font-size:16px;line-height:25px;
                            color:${COLORS.text};">${p}</p>`,
                    )
                    .join('')}
                </td>
              </tr>

              ${blocks ? `<tr><td style="padding:10px 32px 0 32px;">${blocks}</td></tr>` : ''}

              ${
                cta
                  ? `
              <tr>
                <td align="center" style="padding:32px 32px ${ctaCaption ? '10px' : '36px'} 32px;">
                  ${button(cta.href, cta.label)}
                </td>
              </tr>`
                  : ''
              }

              ${
                ctaCaption
                  ? `
              <tr>
                <td align="center" style="padding:0 32px 36px 32px;">
                  <p style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;
                            color:${COLORS.muted};">${ctaCaption}</p>
                </td>
              </tr>`
                  : ''
              }

              ${!cta && !blocks ? '<tr><td style="height:20px;font-size:0;line-height:0;">&nbsp;</td></tr>' : ''}
              ${blocks && !cta ? '<tr><td style="height:36px;font-size:0;line-height:0;">&nbsp;</td></tr>' : ''}
            </table>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:26px 16px 0 16px;">
            <p style="margin:0 0 8px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${COLORS.muted};">
              Kolecta, o hub dos colecionadores.
            </p>
            <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${COLORS.faint};">
              ${reason}<br>
              Precisa de ajuda? Fale com a gente em
              <a href="mailto:${BRAND.support}" style="color:${COLORS.muted};text-decoration:underline;">${BRAND.support}</a>.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * Versão em texto puro. Não é opcional: e-mail só com HTML perde ponto nos
 * filtros de spam e quebra em quem lê por leitor de tela.
 */
export function renderText({
  title,
  paragraphs = [],
  lines = [],
  cta,
}: {
  title: string;
  paragraphs?: string[];
  lines?: string[];
  cta?: { href: string; label: string };
}): string {
  const strip = (s: string) =>
    String(s)
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

  const parts = [title, '', ...paragraphs.map(strip)];
  if (lines.length) parts.push('', ...lines);
  if (cta) parts.push('', `${cta.label}:`, cta.href);
  parts.push(
    '',
    'Kolecta, o hub dos colecionadores.',
    SITE,
    '',
    `Precisa de ajuda? ${BRAND.support}`,
  );
  return parts.join('\n');
}
