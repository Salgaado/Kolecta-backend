/**
 * Regras de valor do saque: mínimo de negócio e taxa da Pagar.me.
 *
 * ── A taxa ────────────────────────────────────────────────────────────────
 * A Pagar.me cobra **R$ 3,67 por saque** ("Taxa de saque" nas condições da
 * conta, ao lado de gateway R$ 0,55 e antifraude R$ 0,44). É valor FIXO por
 * transferência, não percentual, e o extrato a rotula como `(TED)` — mas a
 * cobrança é por saque, então mudar o trilho não muda o preço.
 *
 * Quem paga é o VENDEDOR: a Pagar.me debita do saldo do recebedor dele, junto
 * com o principal, na mesma operação. Aqui é o ESPELHO dessa cobrança — a
 * carteira precisa debitar `valor + taxa` para continuar batendo com o saldo
 * real do recebedor.
 *
 * ⚠️ Não espelhar isso foi o bug de 13/08/2026: a carteira debitava só o
 * principal, então ficava R$ 3,67 mais rica que a realidade a cada saque, e o
 * erro acumulava. Consequência prática: "sacar tudo" NUNCA funcionava — o
 * último saque sempre pedia mais do que existia na Pagar.me. Um vendedor
 * tentou três vezes numa noite e parou a R$ 2,90 de conseguir.
 * Ver `docs/PLAN-taxa-de-saque.md`.
 */

/** Lê um valor em centavos de env, caindo no default se não for inteiro > 0. */
function lerCentavos(nome: string, padrao: number): number {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto.trim() === '') return padrao;

  const valor = parseInt(bruto.trim(), 10);
  if (!Number.isFinite(valor) || valor < 0) {
    console.warn(
      `[withdrawal-fees] ${nome}="${bruto}" não é um valor em centavos válido — usando ${padrao}.`,
    );
    return padrao;
  }
  return valor;
}

/** Mínimo de saque: R$ 50,00. */
export const WITHDRAWAL_MIN_CENTS = lerCentavos(
  'WITHDRAWAL_MIN_AMOUNT_CENTS',
  5000,
);

/** Taxa de saque da Pagar.me: R$ 3,67 fixos por transferência. */
export const WITHDRAWAL_FEE_CENTS = lerCentavos('WITHDRAWAL_FEE_CENTS', 367);

/**
 * Quanto o vendedor consegue de fato sacar.
 *
 * O teto é o MENOR entre o disponível da carteira e o saldo real do recebedor
 * na Pagar.me, menos a taxa. Com o ledger correto os dois são iguais e o
 * `min` não muda nada — ele existe para o dia em que divergirem de novo: aí a
 * tela promete o que existe, em vez de prometer o que a Pagar.me vai recusar.
 *
 * @param recipientAvailableInCents saldo do recebedor, ou `null` quando a
 *        consulta à Pagar.me falhou (nesse caso vale só a carteira).
 */
export function calcMaxWithdrawableInCents(
  walletBalanceInCents: number,
  recipientAvailableInCents: number | null,
): number {
  const teto =
    recipientAvailableInCents === null
      ? walletBalanceInCents
      : Math.min(walletBalanceInCents, recipientAvailableInCents);

  return Math.max(0, teto - WITHDRAWAL_FEE_CENTS);
}
