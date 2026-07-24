/**
 * Split nativo da Pagar.me (fonte única). Usado tanto na compra externa
 * (`orders.service`) quanto no arremate por cartão em leilão (`auctions.service`).
 */

export interface PagarmeSplit {
  recipient_id: string;
  amount: number;
  type: 'flat';
  options: {
    liable: boolean;
    charge_processing_fee: boolean;
    // Nome correto na API v5 da Pagar.me. Enviar `charge_remainder` (sem `_fee`)
    // é ignorado pela API → nenhum recebedor absorve o resto e a cobrança é
    // rejeitada com "At least 1 recipient must be responsible for the
    // charge_remainder_fee".
    charge_remainder_fee: boolean;
  };
}

/**
 * Monta o `split[]` de uma cobrança: líquido pro recebedor do vendedor +
 * comissão pro recebedor da plataforma. Soma == valor da cobrança.
 * - Vendedor: `liable` (responde por chargeback) e `charge_processing_fee`
 *   (absorve a taxa do gateway) — default do plano (§3).
 * - Plataforma: `charge_remainder_fee` (absorve arredondamento). Exatamente 1
 *   recebedor precisa tê-lo em `true`, senão a Pagar.me rejeita a cobrança.
 */
export function buildSplit(
  sellerRecipientId: string,
  chargeAmount: number,
  platformFeeInCents: number,
  platformRecipientId: string,
): PagarmeSplit[] {
  const sellerAmount = chargeAmount - platformFeeInCents;
  return [
    {
      recipient_id: sellerRecipientId,
      amount: sellerAmount,
      type: 'flat',
      options: {
        liable: true,
        charge_processing_fee: true,
        charge_remainder_fee: false,
      },
    },
    {
      recipient_id: platformRecipientId,
      amount: platformFeeInCents,
      type: 'flat',
      options: {
        liable: false,
        charge_processing_fee: false,
        charge_remainder_fee: true,
      },
    },
  ];
}
