// E-mail de aviso — "Estamos melhorando os meios de pagamento"
// Gatilho: MANUAL, via POST /api/admin/broadcast (não tem listener de evento).
//
// É um comunicado de serviço, não peça de marketing: fala de uma mudança
// operacional que afeta como a pessoa paga. Por isso vai para toda a base e não
// tem descadastro — mesma régua do `welcome`, que também é essencial.
import { renderEmail, renderText, alertBox, esc, firstName } from './layout';

export interface AvisoPagamentoData {
  name: string | null;
}

const PARAGRAPHS = (n: string) => [
  `Olá, ${esc(n)}. Estamos passando por melhorias na Kolecta e mudando nossos meios de pagamento — tudo para deixar sua compra mais rápida e mais segura.`,
  `A equipe Kolecta agradece a paciência e a compreensão de todos.`,
];

// A única informação acionável do e-mail: o que continua funcionando hoje.
const AVISO =
  'Durante a transição, o pagamento com <strong>cartão de crédito</strong> pode ' +
  'ficar indisponível em alguns momentos. O <strong>Pix</strong> segue ' +
  'funcionando normalmente para todas as compras.';

export function subject(): string {
  return 'Estamos melhorando os meios de pagamento da Kolecta';
}

export function html(data: AvisoPagamentoData): string {
  return renderEmail({
    preheader: 'Uma mudança nos meios de pagamento. O Pix segue normal.',
    tag: 'Comunicado',
    title: 'Estamos melhorando os meios de pagamento',
    paragraphs: PARAGRAPHS(firstName(data.name)),
    blocks: alertBox(AVISO),
  });
}

export function text(data: AvisoPagamentoData): string {
  return renderText({
    title: 'Estamos melhorando os meios de pagamento',
    paragraphs: PARAGRAPHS(firstName(data.name)),
    lines: [
      'Durante a transição, o pagamento com cartão de crédito pode ficar',
      'indisponível em alguns momentos. O Pix segue funcionando normalmente.',
    ],
  });
}
