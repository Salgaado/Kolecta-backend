// E-mail de recadastro de recebedor — migração para a conta nova da Pagar.me.
// Gatilho: MANUAL, via POST /api/admin/broadcast com audiencia
// 'recebedores-a-recadastrar'. Ver docs/PLAN-pagarme-conta-nova.md (Fase 4.1).
//
// Público pequeno e específico (~24 vendedores), não a base inteira: só quem
// tem recebedor vinculado à conta antiga. Para todo o resto da plataforma nada
// muda, e receber este e-mail só geraria dúvida.
//
// É o e-mail que precisa sair ANTES da troca de credenciais. Depois dela, o
// vendedor sem recebedor válido não consegue vender (fail-closed do split,
// Fase 1) — e descobrir isso sozinho, sem aviso, é o pior desfecho do projeto.
import { renderEmail, renderText, alertBox, BRAND } from './layout';

export interface RecadastroRecebedorData {
  name: string | null;
}

// Sem saudação personalizada, de propósito.
//
// Os 24 destinatários são LOJAS, não pessoas: "GT RACE", "1021 Performance",
// "RA/AP. Diecast", "contato". Passar isso por `firstName()` produz "Olá, Gt",
// "Olá, 1021" e "Olá, Contato" — num e-mail que pede trabalho a donos de loja,
// isso lê como descuido e enfraquece o pedido. Um "Olá!" seco é melhor do que
// um nome errado.

const CTA = {
  href: `${BRAND.site}/painel/recebedor`,
  label: 'Refazer meu cadastro de recebimento',
};

const PARAGRAPHS = [
  `Olá! A Kolecta passou a operar os pagamentos por uma nova conta, agora no CNPJ da empresa. É uma mudança de bastidor, mas ela tem uma consequência para você.`,
  `Seus dados de recebimento estavam vinculados à conta anterior e <strong>precisam ser cadastrados de novo</strong>. Leva poucos minutos e é o mesmo formulário de antes: dados pessoais ou da empresa e a conta bancária onde você recebe.`,
];

// O que acontece se ignorar. Dito sem rodeio: é a informação que evita o
// vendedor descobrir sozinho, com a loja parada.
const AVISO =
  'Enquanto o novo cadastro não estiver aprovado, <strong>suas vendas ficam ' +
  'suspensas</strong> e não é possível sacar. Assim que a aprovação sair, ' +
  'tudo volta ao normal — seus anúncios, seu histórico e seu saldo continuam ' +
  'onde estão.';

export function subject(): string {
  return 'Ação necessária: refaça seu cadastro de recebimento na Kolecta';
}

export function html(): string {
  return renderEmail({
    preheader:
      'Mudamos a conta de pagamentos. Refaça seu cadastro para continuar vendendo.',
    tag: 'Ação necessária',
    title: 'Refaça seu cadastro de recebimento',
    paragraphs: PARAGRAPHS,
    blocks: alertBox(AVISO),
    cta: CTA,
    ctaCaption:
      'Dúvidas? É só responder este e-mail que a gente te ajuda no processo.',
    footerReason:
      'Você recebeu este e-mail porque vende na Kolecta e tem dados de ' +
      'recebimento cadastrados.',
  });
}

export function text(): string {
  return renderText({
    title: 'Refaça seu cadastro de recebimento',
    paragraphs: PARAGRAPHS,
    lines: [
      'Enquanto o novo cadastro não estiver aprovado, suas vendas ficam',
      'suspensas e não é possível sacar. Seus anúncios, seu histórico e seu',
      'saldo continuam onde estão.',
    ],
    cta: CTA,
  });
}
