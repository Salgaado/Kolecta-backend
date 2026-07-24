// E-mail — "KYC pendente — ação necessária" (para o VENDEDOR)
// Gatilho: evento `recipient.kyc.action_needed` (status refused/suspended/blocked).
import {
  renderEmail,
  renderText,
  alertBox,
  COLORS,
  BRAND,
  esc,
  firstName,
} from './layout';

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

const TITLE = 'Precisamos de uma ação sua';

const CTA = {
  href: `${BRAND.site}/painel/recebedor`,
  label: 'Revisar verificação',
};

const reasonOf = (status: string) =>
  STATUS_LABEL[status] ?? 'há uma pendência na sua verificação';

const paragraphs = (data: KycActionNeededData) => [
  `${esc(firstName(data.name))}, identificamos que <strong>${esc(reasonOf(data.status))}</strong>.`,
  `Para voltar a vender e sacar na Kolecta, é preciso revisar e reenviar suas informações de verificação. Se precisar de ajuda, é só responder este e-mail.`,
];

export function subject(): string {
  return 'Ação necessária na sua conta de vendedor';
}

export function html(data: KycActionNeededData): string {
  return renderEmail({
    preheader: 'Revise sua verificação para voltar a vender.',
    tag: 'Ação necessária',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks: alertBox(
      `Enquanto a verificação estiver pendente, novas vendas e saques ficam bloqueados.`,
      { color: COLORS.red },
    ),
    cta: CTA,
  });
}

export function text(data: KycActionNeededData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      'Enquanto a verificação estiver pendente, novas vendas e saques ficam bloqueados.',
    ],
    cta: CTA,
  });
}
