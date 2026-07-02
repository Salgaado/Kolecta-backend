// E-mail #15 — "KYC pendente — ação necessária" (para o VENDEDOR)
// Gatilho: evento `recipient.kyc.action_needed` (status refused/suspended/blocked).
import { renderLayout, BRAND } from './layout';

export interface KycActionNeededData {
  name: string | null;
  /** Status do recebedor na Pagar.me (refused | suspended | blocked). */
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  refused: 'sua verificação não foi aprovada',
  suspended: 'sua conta de recebimento foi suspensa',
  blocked: 'sua conta de recebimento foi bloqueada',
};

export function subject(): string {
  return '⚠️ Ação necessária na sua conta de vendedor';
}

export function html(data: KycActionNeededData): string {
  const greeting = data.name ? `Olá, ${data.name}!` : 'Olá!';
  const reason =
    STATUS_LABEL[data.status] ?? 'há uma pendência na sua verificação';
  return renderLayout({
    heading: '⚠️ Precisamos de uma ação sua',
    body: `
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">Identificamos que <strong>${reason}</strong>. Para voltar a vender e sacar na Kolecta, é preciso revisar e reenviar suas informações de verificação.</p>
      <p style="margin:12px 0 0;">Acesse sua conta para concluir a verificação. Se precisar de ajuda, é só responder este e-mail.</p>
    `,
    ctaLabel: 'Revisar verificação',
    ctaUrl: `${BRAND.site}/seller/onboarding`,
  });
}
