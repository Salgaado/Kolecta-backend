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
