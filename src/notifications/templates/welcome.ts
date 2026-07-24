// E-mail #1 — "Bem-vindo à Kolecta" (para o USUÁRIO recém-cadastrado)
// Gatilho: evento `user.registered`, emitido no webhook user.created do Clerk.
// Essencial: é o recibo do cadastro, não tem opção de desligar.
// Conteúdo portado de `emails/templates.mjs` → boasVindas().
import {
  renderEmail,
  renderText,
  checklistBox,
  BRAND,
  esc,
  firstName,
} from './layout';

export interface WelcomeData {
  name: string | null;
}

const CTA = {
  href: `${BRAND.site}/painel/anuncios/novo`,
  label: 'Publicar meu primeiro anúncio',
};

const PARAGRAPHS = (n: string) => [
  `Sua conta está criada, ${esc(n)}. A Kolecta é o point de quem coleciona: miniaturas, cards, action figures, Funko e mangá, com compra direta e leilão no mesmo lugar.`,
  `Você já pode montar sua vitrine. Todo mundo na Kolecta pode vender, não existe cadastro separado de vendedor.`,
];

export function subject(data: WelcomeData): string {
  return `Bem-vindo à Kolecta, ${firstName(data.name)}`;
}

export function html(data: WelcomeData): string {
  return renderEmail({
    preheader: 'Sua conta está pronta. Veja por onde começar.',
    tag: 'Boas-vindas',
    title: `Bem-vindo à Kolecta, ${firstName(data.name)}`,
    paragraphs: PARAGRAPHS(firstName(data.name)),
    blocks: checklistBox({
      title: 'Por onde começar',
      items: [
        'Publique seu primeiro anúncio, leva menos de 3 minutos',
        'Cadastre seu endereço para o frete sair calculado certo',
        'Configure seus dados de recebimento para poder sacar',
      ],
    }),
    cta: CTA,
  });
}

export function text(data: WelcomeData): string {
  return renderText({
    title: `Bem-vindo à Kolecta, ${firstName(data.name)}`,
    paragraphs: PARAGRAPHS(firstName(data.name)),
    lines: [
      'Por onde começar:',
      '- Publique seu primeiro anúncio',
      '- Cadastre seu endereço',
      '- Configure seus dados de recebimento',
    ],
    cta: CTA,
  });
}
