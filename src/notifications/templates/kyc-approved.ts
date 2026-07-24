// E-mail #14 — "KYC aprovado — pode vender!" (para o VENDEDOR)
// Gatilho: evento `recipient.kyc.approved` (status do recebedor = active).
import { renderLayout, BRAND } from './layout';

export interface KycApprovedData {
  name: string | null;
}

export function subject(): string {
  return '✅ Sua conta de vendedor foi aprovada!';
}

export function html(data: KycApprovedData): string {
  const greeting = data.name ? `Olá, ${data.name}!` : 'Olá!';
  return renderLayout({
    heading: '✅ Verificação concluída — você já pode vender!',
    body: `
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">Boas notícias: sua identidade foi verificada e sua conta de recebimento está <strong>ativa</strong>. A partir de agora você pode publicar anúncios, vender e sacar seus ganhos na Kolecta.</p>
      <p style="margin:12px 0 0;">Que tal começar criando seu primeiro anúncio?</p>
    `,
    ctaLabel: 'Criar anúncio',
    ctaUrl: `${BRAND.site}/painel/anuncios/novo`,
  });
}
