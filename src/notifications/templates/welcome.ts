// E-mail #1 — "Bem-vindo à Kolecta" (para o USUÁRIO recém-cadastrado)
// Gatilho: evento `user.registered`, emitido no webhook user.created do Clerk.
// Essencial: é o recibo do cadastro, não tem opção de desligar.
// Conteúdo portado de `emails/templates.mjs` → boasVindas().
import { renderLayout, BRAND, esc, firstName } from './layout';

export interface WelcomeData {
  name: string | null;
}

export function subject(data: WelcomeData): string {
  const n = firstName(data.name);
  return n ? `Bem-vindo à Kolecta, ${n}` : 'Bem-vindo à Kolecta';
}

export function html(data: WelcomeData): string {
  const n = firstName(data.name);
  const greeting = n ? `Olá, ${esc(n)}!` : 'Olá!';

  return renderLayout({
    heading: '🎉 Sua conta está criada!',
    body: `
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">A Kolecta é o point de quem coleciona: miniaturas, cards, action figures, Funko e mangá — com compra direta e leilão no mesmo lugar.</p>
      <p style="margin:0 0 16px;">Você já pode montar sua vitrine. Todo mundo na Kolecta pode vender, não existe cadastro separado de vendedor.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};border-radius:12px;margin:0 0 8px;">
        <tr><td style="padding:16px 20px;">
          <p style="margin:0 0 8px;font-weight:600;color:#1f2937;">Por onde começar</p>
          <p style="margin:0 0 6px;">• Publique seu primeiro anúncio — leva menos de 3 minutos</p>
          <p style="margin:0 0 6px;">• Cadastre seu endereço para o frete sair calculado certo</p>
          <p style="margin:0;">• Configure seus dados de recebimento para poder sacar</p>
        </td></tr>
      </table>
    `,
    ctaLabel: 'Publicar meu primeiro anúncio',
    ctaUrl: `${BRAND.site}/painel/anuncios/novo`,
  });
}
