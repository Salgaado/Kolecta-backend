// E-mail — "KYC aprovado — pode vender!" (para o VENDEDOR)
// Gatilho: evento `recipient.kyc.approved` (status do recebedor = active).
import {
  renderEmail,
  renderText,
  checklistBox,
  BRAND,
  esc,
  firstName,
} from './layout';

export interface KycApprovedData {
  name: string | null;
}

const TITLE = 'Verificação concluída — você já pode vender!';

const CTA = {
  href: `${BRAND.site}/painel/anuncios/novo`,
  label: 'Criar anúncio',
};

const paragraphs = (data: KycApprovedData) => [
  `Boas notícias, ${esc(firstName(data.name))}: sua identidade foi verificada e sua conta de recebimento está <strong>ativa</strong>.`,
  `A partir de agora você pode publicar anúncios, vender e sacar seus ganhos na Kolecta.`,
];

export function subject(): string {
  return 'Sua conta de vendedor foi aprovada!';
}

export function html(data: KycApprovedData): string {
  return renderEmail({
    preheader: 'Sua conta de recebimento está ativa.',
    tag: 'Verificação aprovada',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks: checklistBox({
      title: 'O que já está liberado',
      items: [
        'Publicar anúncios e leilões',
        'Receber pagamentos com split automático',
        'Sacar o saldo liberado para sua conta',
      ],
    }),
    cta: CTA,
  });
}

export function text(data: KycApprovedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    cta: CTA,
  });
}
