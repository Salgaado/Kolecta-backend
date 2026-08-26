/**
 * Adaptador do BLING para a sincronização de estoque.
 *
 * As regras de o que fazer com cada saldo (não tocar em leilão, não ressuscitar
 * o que a moderação recusou, distinguir pausa por falta de peça de pausa na
 * mão) são da Kolecta e valem para qualquer ERP — moraram aqui até 25/08/2026 e
 * hoje vivem em `common/erp/estoque-sync.ts`, compartilhadas com o Tiny.
 *
 * O que sobrou aqui é só o que é do Bling: o formato da resposta de
 * `/estoques/saldos` e o tamanho do lote que a URL dele aguenta.
 *
 * As reexportações no fim existem para que quem já importava daqui continue
 * funcionando — e para que o serviço do Bling não precise conhecer dois
 * caminhos de import.
 */
import { normalizarSaldo } from '../common/erp/estoque-sync';

/** Saldo de um produto como o Bling devolve em `/estoques/saldos`. */
export interface SaldoBling {
  produto: { id: number; codigo?: string };
  saldoFisicoTotal?: number;
  saldoVirtualTotal?: number;
}

/**
 * Saldo utilizável a partir do que o Bling devolveu.
 *
 * Usa o VIRTUAL, não o físico. Virtual é o físico menos o que já está reservado
 * por pedido em aberto, inclusive o pedido de venda que a própria Kolecta cria
 * no Bling quando a compra é paga. Físico só cai quando a peça sai da caixa, e
 * até lá o anúncio continuaria vendendo algo que já tem dono.
 *
 * Negativo vira zero e ausência vira `null` — ver `normalizarSaldo`.
 */
export function saldoUtil(saldo: SaldoBling | undefined | null): number | null {
  if (!saldo) return null;
  return normalizarSaldo(saldo.saldoVirtualTotal ?? saldo.saldoFisicoTotal);
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
 *
 * O Tiny não tem endpoint em lote nenhum (é um produto por chamada), então isto
 * é mesmo do Bling e fica aqui.
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

export {
  decidir,
  normalizarSaldo,
  type Atualizacao,
  type AnuncioParaSincronizar,
} from '../common/erp/estoque-sync';
