/**
 * Regras da sincronização de estoque com o Bling. Puras, sem banco nem rede.
 *
 * O ERP do lojista é a fonte da verdade do estoque, e é esse o ponto da
 * integração: ele vende a mesma peça no balcão, no Mercado Livre e aqui. Sem
 * seguir o saldo, a peça sai da prateleira e o anúncio da Kolecta continua no
 * ar, até alguém comprar o que não existe mais.
 *
 * O que este arquivo NÃO faz de propósito: mexer em anúncio que não veio do
 * Bling, em leilão, e em anúncio que a moderação recusou. Ver `decidir`.
 */

/** Saldo de um produto como o Bling devolve em `/estoques/saldos`. */
export interface SaldoBling {
  produto: { id: number; codigo?: string };
  saldoFisicoTotal?: number;
  saldoVirtualTotal?: number;
}

export interface AnuncioParaSincronizar {
  id: string;
  blingProductId: number | null;
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
 * `rejected` e `cancelled` ficam de fora porque são decisão da moderação: o
 * Bling não sabe que o anúncio foi recusado aqui, e deixar o saldo reativá-lo
 * seria o ERP passando por cima de uma decisão da Kolecta.
 *
 * `sold` também fica de fora. É o beco sem saída do MVP (anúncio de unidade
 * única, sem controle de estoque), e não é de lá que vem quem foi importado.
 */
const STATUS_SINCRONIZAVEIS = new Set(['active', 'paused', 'pending_review', 'draft']);

/**
 * Saldo utilizável a partir do que o Bling devolveu.
 *
 * Usa o VIRTUAL, não o físico. Virtual é o físico menos o que já está reservado
 * por pedido em aberto, inclusive o pedido de venda que a própria Kolecta cria
 * no Bling quando a compra é paga. Físico só cai quando a peça sai da caixa, e
 * até lá o anúncio continuaria vendendo algo que já tem dono.
 *
 * Negativo vira zero: catálogo real tem produto com saldo -4 (conferido em
 * produção em 06/08/2026, uma loja com venda lançada sem entrada). Guardar
 * negativo aqui faria a conta de "tem estoque?" errar em silêncio.
 */
export function saldoUtil(saldo: SaldoBling | undefined | null): number | null {
  if (!saldo) return null;
  const bruto = saldo.saldoVirtualTotal ?? saldo.saldoFisicoTotal;
  if (typeof bruto !== 'number' || !Number.isFinite(bruto)) return null;
  return Math.max(0, Math.trunc(bruto));
}

/**
 * O que fazer com um anúncio, dado o saldo do Bling. `null` = nada a fazer.
 *
 * Devolver `null` quando nada muda não é economia de escrita à toa: sem isso, a
 * sincronização de meia em meia hora carimbaria `updatedAt` em todo o catálogo
 * do lojista, e a vitrine, que ordena por atualização, viraria um sorteio a
 * cada rodada.
 */
export function decidir(
  anuncio: AnuncioParaSincronizar,
  saldo: SaldoBling | undefined | null,
): Atualizacao | null {
  if (!anuncio.blingProductId) return null;
  // Leilão é UMA peça, com prazo e lances correndo. Se o lojista mexer no saldo
  // do ERP no meio do pregão, o leilão não pode sumir por baixo de quem já deu
  // lance.
  if (anuncio.type === 'auction') return null;
  if (!STATUS_SINCRONIZAVEIS.has(anuncio.status)) return null;

  const novo = saldoUtil(saldo);
  // Produto que o Bling não devolveu (apagado, ou fora do lote): não inventa
  // saldo. Zerar por ausência tiraria do ar um anúncio que talvez esteja certo.
  if (novo == null) return null;

  const atual = anuncio.stock;
  const pausadoPeloEstoque = !!anuncio.pausedByStock;

  // Zerou: sai do ar. `paused` e não `sold` porque pausado o lojista repõe e
  // reativa direto, enquanto `sold` obrigaria a recriar o anúncio. Mesma escolha
  // que a baixa de estoque por venda já faz.
  if (novo === 0 && anuncio.status === 'active') {
    return { id: anuncio.id, stock: 0, status: 'paused', pausedByStock: true, motivo: 'zerou' };
  }

  // Voltou a ter peça: só reativa o que a PRÓPRIA falta de estoque tirou do ar.
  // Anúncio que o lojista pausou na mão continua pausado, senão o ERP estaria
  // republicando o que ele decidiu tirar da vitrine.
  if (novo > 0 && anuncio.status === 'paused' && pausadoPeloEstoque) {
    return { id: anuncio.id, stock: novo, status: 'active', pausedByStock: false, motivo: 'voltou' };
  }

  if (novo === atual) return null;
  return { id: anuncio.id, stock: novo, motivo: 'saldo' };
}

/**
 * Quebra os ids em lotes para o `/estoques/saldos`.
 *
 * O limite não é de itens, é do tamanho da URL: cada id vira um
 * `idsProdutos[]=16654609068` na query. Medido contra a API em 06/08/2026,
 * com ids reais de 11 dígitos:
 *
 *   50  ids -> 1347 caracteres -> 200
 *   100 ids -> 2647 caracteres -> 200
 *   200 ids -> 5247 caracteres -> 200
 *   300 ids -> 7847 caracteres -> 414 Request-URI Too Long
 *
 * 100 é metade do maior valor que passou, o que deixa folga se um dia os ids
 * ficarem mais longos, e ainda resolve o catálogo de mil produtos em dez
 * chamadas.
 */
export const POR_LOTE = 100;

export function emLotes<T>(itens: readonly T[], tamanho = POR_LOTE): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }
  return lotes;
}

/** Indexa a resposta do Bling por id de produto. */
export function porProduto(saldos: readonly SaldoBling[]): Map<number, SaldoBling> {
  const mapa = new Map<number, SaldoBling>();
  for (const s of saldos ?? []) {
    const id = Number(s?.produto?.id);
    if (Number.isFinite(id)) mapa.set(id, s);
  }
  return mapa;
}
