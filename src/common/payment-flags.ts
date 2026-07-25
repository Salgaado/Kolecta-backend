/**
 * Interruptor do pagamento com cartão de crédito.
 *
 * A Pagar.me está reprovando por antifraude TODAS as compras no cartão —
 * inclusive a pré-autorização do lance, que é 100% cartão. Enquanto o limiar da
 * conta não for ajustado com eles, o cartão fica fechado na plataforma inteira
 * e o PIX segue normal.
 *
 * Fecha por PADRÃO de propósito: reabrir exige alguém ligar explicitamente
 * (`PAGAMENTO_CARTAO_HABILITADO=true`). Se a variável sumir num redeploy, o
 * pior caso é continuar fechado — e não voltar a aceitar cobrança que o
 * gateway recusa, deixando comprador e vendedor no meio do caminho.
 */
export const CARTAO_HABILITADO =
  process.env.PAGAMENTO_CARTAO_HABILITADO === 'true';

/** Mensagem única, para comprador e vendedor lerem a mesma coisa. */
export const CARTAO_INDISPONIVEL =
  'Pagamento com cartão de crédito temporariamente indisponível. ' +
  'Use Pix para concluir — em breve liberamos o cartão.';

/** Mesma indisponibilidade, dita para quem tenta dar um lance. */
export const LANCE_INDISPONIVEL =
  'Os lances estão temporariamente suspensos: eles são garantidos por cartão ' +
  'de crédito, e o pagamento com cartão está indisponível no momento. ' +
  'Em breve liberamos.';
