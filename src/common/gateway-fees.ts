/**
 * Taxa que a Pagar.me retém do VENDEDOR, por instrumento de pagamento.
 *
 * Fonte única: até 31/07 cada serviço tinha a sua cópia — `orders.service.ts`
 * lia as env e `auctions.service.ts` gravava `0` fixo, o que fazia o mesmo
 * arremate valer dois números diferentes dependendo do caminho.
 *
 * Quem cobra é a própria Pagar.me, via `charge_processing_fee: true` no
 * recebedor do vendedor (ver `pagarme-split.ts`). Aqui é só o ESPELHO: o valor
 * que a carteira interna precisa descontar para bater com o que de fato cai no
 * recebedor. Espelho errado não muda o repasse — muda o saldo que o vendedor vê
 * e o valor que ele tenta sacar, e o saque falha por saldo insuficiente.
 *
 * Valores do contrato ("Condições acordadas" da conta nova, 07/2026):
 * MDR crédito à vista 3,89% · PIX 1,09%.
 *
 * ⚠️ Só percentual. O contrato também tem custo FIXO por transação
 * (gateway R$ 0,55 + antifraude R$ 0,44) que este modelo não expressa — numa
 * venda de R$ 100 isso é ~1%, então o espelho fica perto, não exato.
 */

/** Cartão de crédito: MDR à vista. Configurável via env. */
export const CARD_FEE_PERCENT = parseFloat(
  process.env.PAGARME_CARD_FEE_PERCENT ?? '0',
);

/** Demais instrumentos (PIX). Configurável via env. */
export const GATEWAY_FEE_PERCENT = parseFloat(
  process.env.PAGARME_GATEWAY_FEE_PERCENT ?? '0',
);

/**
 * Taxa do gateway em centavos.
 *
 * @param baseInCents valor que passou pelo gateway — NÃO inclui a parcela paga
 *        com saldo da wallet nem os juros do parcelamento.
 */
export function calcGatewayFeeInCents(
  baseInCents: number,
  instrument: string | null | undefined,
): number {
  const percent =
    instrument === 'credit_card' ? CARD_FEE_PERCENT : GATEWAY_FEE_PERCENT;
  return Math.round((baseInCents * percent) / 100);
}
