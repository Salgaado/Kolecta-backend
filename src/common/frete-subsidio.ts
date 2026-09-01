/**
 * Frete compartilhado: quanto do frete a Kolecta banca.
 *
 * A política inteira, formalizada (ver `docs/PLAN-frete-compartilhado.md`):
 *
 *   P = preço do item (centavos)
 *   F = frete da opção elegível MAIS BARATA (centavos)
 *   c = comissão base = 11%  (SEMPRE 11%, mesmo para fundador)
 *
 *   elegível  ⟺  P ≥ R$ 100
 *   S = elegível ? min(F, 0,07 × P, R$ 30) : 0
 *
 *   comprador paga  = P + (F − S)
 *   vendedor recebe = P − (c × P)          ← INALTERADO pela política
 *   Kolecta líquido = (c × P) − S
 *   take líquido    = c − min(F/P, 7%)     ← trava em 4% quando F/P ≥ 7%
 *
 * ── Duas decisões que estão AQUI e não em outro lugar ────────────────────────
 *
 * **A âncora é a opção mais barata, não a escolhida.** Se o comprador prefere
 * uma transportadora mais cara, a diferença é por conta dele. Sem isso,
 * cobertura de 100% significa que todo mundo escolhe SEDEX e o subsídio sobe
 * ~50%.
 *
 * **A base é sempre 11%, inclusive para fundador.** O desconto de 9% é um
 * benefício do VENDEDOR; calcular o subsídio sobre 9% faria o comprador de um
 * fundador pagar mais frete pelo mesmo item — punido por um benefício que não é
 * dele. O preço disso é que o take numa venda de fundador cai a 2% (9% − 7%), e
 * não aos 4% do resto. É decisão consciente (D1 do plano), reversível pelo env.
 *
 * ── A invariante que este módulo protege ────────────────────────────────────
 *
 * `orders.shipping_in_cents` continua significando *frete cobrado do comprador*
 * — agora `F − S`. O custo cheio vai para `shipping_cost_in_cents` e o subsídio
 * para `shipping_subsidy_in_cents`, com
 *
 *     shipping_cost = shipping_in + shipping_subsidy
 *
 * É essa escolha que mantém `platformFee = comissão + shippingInCents` correto
 * nos SEIS pontos que calculam `platformFeeInCents` (`orders.service.ts:705`,
 * `:1715`; `auctions.service.ts:1212`, `:1451`, `:2054`, `:2350`) sem tocar em
 * nenhum deles. Quem for mexer nesses pontos precisa manter essa igualdade —
 * ela é o contrato do split, e há teste para cada um.
 *
 * Função PURA de propósito: sem I/O, sem env lido aqui dentro, sem `Date`. A
 * política entra por parâmetro para o teste conseguir varrer o espaço todo.
 */

export interface PoliticaSubsidio {
  /** Desligado = subsídio sempre 0. Default OFF: ligar é uma variável no Render. */
  ativo: boolean;
  /** Fração do ITEM que a Kolecta cobre, em pontos percentuais (7 = 7%). */
  percentualDoItem: number;
  /** Teto absoluto por pedido, em centavos. */
  tetoEmCentavos: number;
  /** Abaixo deste preço de item não há subsídio nenhum. */
  pisoDoItemEmCentavos: number;
}

/** Política desligada — o que vale quando o env não diz nada. */
export const POLITICA_DESLIGADA: PoliticaSubsidio = {
  ativo: false,
  percentualDoItem: 7,
  tetoEmCentavos: 3000,
  pisoDoItemEmCentavos: 10000,
};

function inteiroDoAmbiente(nome: string, padrao: number): number {
  const bruto = process.env[nome];
  if (bruto == null || bruto.trim() === '') return padrao;
  const n = Number(bruto);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : padrao;
}

/**
 * Lê a política do ambiente. Chamada uma vez por checkout — nunca de dentro das
 * funções de cálculo, que precisam continuar puras.
 *
 *   FRETE_SUBSIDIO_ATIVO=false               # default OFF
 *   FRETE_SUBSIDIO_PERCENT=7
 *   FRETE_SUBSIDIO_TETO_EM_CENTAVOS=3000
 *   FRETE_SUBSIDIO_PISO_ITEM_EM_CENTAVOS=10000
 */
export function politicaDoAmbiente(): PoliticaSubsidio {
  return {
    ativo:
      (process.env.FRETE_SUBSIDIO_ATIVO ?? 'false').toLowerCase() === 'true',
    percentualDoItem: inteiroDoAmbiente('FRETE_SUBSIDIO_PERCENT', 7),
    tetoEmCentavos: inteiroDoAmbiente('FRETE_SUBSIDIO_TETO_EM_CENTAVOS', 3000),
    pisoDoItemEmCentavos: inteiroDoAmbiente(
      'FRETE_SUBSIDIO_PISO_ITEM_EM_CENTAVOS',
      10000,
    ),
  };
}

/**
 * O TETO do subsídio para um item, sem saber o frete.
 *
 * É o número do selo — *"a Kolecta paga até R$ 12,25 do seu frete"* —, e é o
 * motivo de esta política ser implementável no card e na busca: depende só do
 * preço do anúncio, não do CEP. A frase é sempre verdadeira porque o `min` com
 * o frete real só pode REDUZIR esse valor, nunca aumentá-lo.
 *
 * (Na escada analisada em `ANALISE-split-frete-escada.md` isto era impossível:
 * a cobertura dependia do CEP, que não existe na listagem.)
 */
export function subsidioMaximoEmCentavos(
  itemInCents: number,
  politica: PoliticaSubsidio,
): number {
  if (!politica.ativo) return 0;
  if (
    !Number.isFinite(itemInCents) ||
    itemInCents < politica.pisoDoItemEmCentavos
  ) {
    return 0;
  }
  const porPercentual = Math.round(
    (itemInCents * politica.percentualDoItem) / 100,
  );
  return Math.max(0, Math.min(porPercentual, politica.tetoEmCentavos));
}

/**
 * O subsídio efetivo de um pedido.
 *
 * `freteMaisBaratoInCents` é a ÂNCORA — a opção elegível mais barata da rota,
 * não a que o comprador escolheu (ver o cabeçalho). Passar o frete escolhido
 * aqui é o vazamento nº 1 da política.
 */
export function subsidioEmCentavos(
  itemInCents: number,
  freteMaisBaratoInCents: number,
  politica: PoliticaSubsidio,
): number {
  const teto = subsidioMaximoEmCentavos(itemInCents, politica);
  if (teto <= 0) return 0;
  if (!Number.isFinite(freteMaisBaratoInCents) || freteMaisBaratoInCents <= 0) {
    return 0;
  }
  return Math.min(teto, Math.trunc(freteMaisBaratoInCents));
}
