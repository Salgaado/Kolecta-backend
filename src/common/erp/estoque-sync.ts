/**
 * Regras da sincronização de estoque com o ERP do lojista. Puras, sem banco,
 * sem rede e sem Nest.
 *
 * O ERP do lojista é a fonte da verdade do estoque, e é esse o ponto da
 * integração: ele vende a mesma peça no balcão, no Mercado Livre e aqui. Sem
 * seguir o saldo, a peça sai da prateleira e o anúncio da Kolecta continua no
 * ar, até alguém comprar o que não existe mais.
 *
 * Este arquivo nasceu dentro de `bling/` e saiu de lá quando o Tiny (Olist ERP)
 * entrou no plano. O motivo da mudança é que NADA aqui é sobre o Bling: não
 * mexer em leilão, não ressuscitar o que a moderação recusou e distinguir
 * "pausado por falta de peça" de "pausado pelo lojista" são decisões da
 * KOLECTA. O que muda de um ERP para o outro é só o formato do saldo, e isso
 * fica no adaptador de cada um (`bling/estoque-sync.ts`, `tiny/…`), que entrega
 * aqui um número já normalizado.
 */

export interface AnuncioParaSincronizar {
  id: string;
  /**
   * Id do produto no ERP de origem — `bling_product_id` ou `tiny_product_id`,
   * conforme de onde o anúncio veio. `null` = anúncio criado na Kolecta, que
   * não tem ERP para seguir.
   */
  erpProductId: number | null;
  type: string;
  status: string;
  stock: number | null;
  pausedByStock: number | boolean | null;
}

export interface Atualizacao {
  id: string;
  stock: number;
  /** Só vem quando o anúncio entra ou sai do ar por causa do saldo. */
  status?: 'active' | 'paused';
  pausedByStock?: boolean;
  motivo: 'saldo' | 'zerou' | 'voltou';
}

/**
 * Status que a sincronização pode tocar.
 *
 * `rejected` e `cancelled` ficam de fora porque são decisão da moderação: o ERP
 * não sabe que o anúncio foi recusado aqui, e deixar o saldo reativá-lo seria o
 * ERP passando por cima de uma decisão da Kolecta.
 *
 * `sold` também fica de fora. É o beco sem saída do MVP (anúncio de unidade
 * única, sem controle de estoque), e não é de lá que vem quem foi importado.
 */
const STATUS_SINCRONIZAVEIS = new Set([
  'active',
  'paused',
  'pending_review',
  'draft',
]);

/**
 * Saldo utilizável a partir do número cru que o ERP devolveu.
 *
 * Negativo vira zero: catálogo real tem produto com saldo -4 (conferido em
 * produção em 06/08/2026, uma loja com venda lançada sem entrada). Guardar
 * negativo aqui faria a conta de "tem estoque?" errar em silêncio.
 *
 * `null` é diferente de `0` e a diferença é o ponto: `null` é "não sei", e quem
 * não sabe não tira anúncio do ar.
 */
export function normalizarSaldo(bruto: unknown): number | null {
  if (typeof bruto !== 'number' || !Number.isFinite(bruto)) return null;
  return Math.max(0, Math.trunc(bruto));
}

/**
 * O que fazer com um anúncio, dado o saldo já normalizado do ERP.
 * `null` = nada a fazer.
 *
 * Devolver `null` quando nada muda não é economia de escrita à toa: sem isso, a
 * sincronização de meia em meia hora carimbaria `updatedAt` em todo o catálogo
 * do lojista, e a vitrine, que ordena por atualização, viraria um sorteio a
 * cada rodada.
 */
export function decidir(
  anuncio: AnuncioParaSincronizar,
  saldo: number | null | undefined,
): Atualizacao | null {
  if (!anuncio.erpProductId) return null;
  // Leilão é UMA peça, com prazo e lances correndo. Se o lojista mexer no saldo
  // do ERP no meio do pregão, o leilão não pode sumir por baixo de quem já deu
  // lance.
  if (anuncio.type === 'auction') return null;
  if (!STATUS_SINCRONIZAVEIS.has(anuncio.status)) return null;

  // Produto que o ERP não devolveu (apagado, fora do lote, ou uma consulta que
  // falhou): não inventa saldo. Zerar por ausência tiraria do ar um anúncio que
  // talvez esteja certo.
  const novo = normalizarSaldo(saldo);
  if (novo == null) return null;

  const atual = anuncio.stock;
  const pausadoPeloEstoque = !!anuncio.pausedByStock;

  // Zerou: sai do ar. `paused` e não `sold` porque pausado o lojista repõe e
  // reativa direto, enquanto `sold` obrigaria a recriar o anúncio. Mesma escolha
  // que a baixa de estoque por venda já faz.
  if (novo === 0 && anuncio.status === 'active') {
    return {
      id: anuncio.id,
      stock: 0,
      status: 'paused',
      pausedByStock: true,
      motivo: 'zerou',
    };
  }

  // Voltou a ter peça: só reativa o que a PRÓPRIA falta de estoque tirou do ar.
  // Anúncio que o lojista pausou na mão continua pausado, senão o ERP estaria
  // republicando o que ele decidiu tirar da vitrine.
  if (novo > 0 && anuncio.status === 'paused' && pausadoPeloEstoque) {
    return {
      id: anuncio.id,
      stock: novo,
      status: 'active',
      pausedByStock: false,
      motivo: 'voltou',
    };
  }

  if (novo === atual) return null;
  return { id: anuncio.id, stock: novo, motivo: 'saldo' };
}
