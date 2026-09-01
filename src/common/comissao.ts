/**
 * A comissão da Kolecta num pedido, separada do frete.
 *
 * `orders.platform_fee_in_cents` **não é receita**. Desde `3ba9a4e` (25/07/2026,
 * "frete vai para a Kolecta") ele guarda **comissão + frete inteiro**, porque o
 * frete passa pela plataforma só para comprar a etiqueta — entra e sai. Somar a
 * coluna e chamar de receita inflou o painel em ~4x: em 31/07 ele mostrava
 * R$ 20,22 de "receita (taxas)" onde a comissão real era R$ 4,95.
 *
 * Pior que o exagero é a incomparabilidade: **o campo mudou de significado no
 * meio do caminho.** Antes daquele commit ele era só comissão. Somar a coluna
 * inteira mistura duas definições — num pedido de 25/07 de manhã, subtrair o
 * frete dá comissão negativa de R$ 13,47, que é o sintoma do desencontro.
 *
 * A regra abaixo acerta as duas eras sem depender de data de deploy:
 *
 *  - **Pedido novo** (frete embutido): `fee = comissão + frete`, e como a
 *    comissão é sempre > 0, vale `fee > frete` → subtrai e sobra a comissão.
 *    Com retirada em mãos o frete é 0 e a subtração não muda nada.
 *  - **Pedido antigo** (frete ia para o vendedor): `fee = comissão`. Quando há
 *    frete, ele costuma superar a comissão, então `fee < frete` → devolve `fee`
 *    inteiro, que é a resposta certa.
 *
 * O canto cego é um pedido ANTIGO em que a comissão superava o frete (item caro,
 * frete barato). Não existe nenhum assim no banco — conferidos os 6 pedidos de
 * venda em 31/07/2026 —, e pedido antigo não nasce mais. Se um dia aparecer, a
 * comissão dele sai subestimada, nunca inflada.
 */
export function comissaoEmCentavos(pedido: {
  platformFeeInCents?: number | null;
  shippingInCents?: number | null;
}): number {
  const taxa = pedido.platformFeeInCents ?? 0;
  const frete = pedido.shippingInCents ?? 0;
  return taxa > frete ? taxa - frete : taxa;
}

/** O que do campo `platform_fee` é frete, e portanto não é receita. */
export function freteEmCentavos(pedido: {
  platformFeeInCents?: number | null;
  shippingInCents?: number | null;
}): number {
  const taxa = pedido.platformFeeInCents ?? 0;
  return taxa - comissaoEmCentavos(pedido);
}

/**
 * O que a Kolecta REALMENTE embolsa: a comissão menos o frete que ela bancou.
 *
 * `comissaoEmCentavos` continua certa depois do frete compartilhado — ela
 * devolve a comissão BRUTA, e é isso que ela promete. Mas somar comissão bruta
 * e chamar de receita repete, com outro nome, o erro de 31/07: o subsídio é
 * dinheiro que sai, e some da conta se ninguém o subtrair. Num pedido no ticket
 * médio (item R$ 165,23, frete R$ 13,76) a comissão é R$ 18,18 e o subsídio
 * R$ 11,57 — **64% da receita bruta**. Errar isso não é detalhe de arredondamento.
 *
 * Toda soma que vira "receita" no painel financeiro passa por AQUI, não por
 * `comissaoEmCentavos`. Ver `docs/PLAN-frete-compartilhado.md` §2.3.
 *
 * Pedido anterior à política tem `shippingSubsidyInCents` nulo, e as duas
 * funções coincidem — que é a resposta certa: ninguém subsidiou nada antes.
 */
export function receitaLiquidaEmCentavos(pedido: {
  platformFeeInCents?: number | null;
  shippingInCents?: number | null;
  shippingSubsidyInCents?: number | null;
}): number {
  return comissaoEmCentavos(pedido) - (pedido.shippingSubsidyInCents ?? 0);
}

/**
 * O custo cheio da etiqueta — o que a Kolecta paga ao Melhor Envio.
 *
 * Existe para quem precisa do frete REAL e não do cobrado: a referência do
 * `TETO_DE_ABSORCAO` na troca de transportadora é o caso que dói, porque ler o
 * valor subsidiado ali encolhe o teto e recusa alternativas legítimas com o
 * pedido já pago.
 *
 * Pedido anterior à política não tem a coluna: cai no frete cobrado, que era o
 * custo cheio na época.
 */
export function freteCheioEmCentavos(pedido: {
  shippingInCents?: number | null;
  shippingCostInCents?: number | null;
}): number {
  return pedido.shippingCostInCents ?? pedido.shippingInCents ?? 0;
}
