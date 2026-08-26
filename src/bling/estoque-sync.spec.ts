import { saldoUtil, emLotes, porProduto, POR_LOTE } from './estoque-sync';

/**
 * O que sobrou aqui é o que é do BLING: ler o saldo do formato dele e caber na
 * URL dele. As decisões de negócio (o que fazer com cada saldo) mudaram de
 * casa em 25/08/2026 e são testadas em `common/erp/estoque-sync.spec.ts`.
 */

const saldo = (n: number) => ({ produto: { id: 16654609068 }, saldoVirtualTotal: n });

describe('saldoUtil', () => {
  it('usa o saldo virtual, que já desconta o que está reservado', () => {
    expect(
      saldoUtil({ produto: { id: 1 }, saldoFisicoTotal: 5, saldoVirtualTotal: 2 }),
    ).toBe(2);
  });

  it('cai no físico quando o virtual não veio', () => {
    expect(saldoUtil({ produto: { id: 1 }, saldoFisicoTotal: 5 })).toBe(5);
  });

  it('negativo vira zero (catálogo real tem produto com -4)', () => {
    expect(saldoUtil(saldo(-4))).toBe(0);
  });

  it('sem saldo nenhum devolve null, e não zero', () => {
    // A diferença importa: null é "não sei", e quem não sabe não tira do ar.
    expect(saldoUtil(undefined)).toBeNull();
    expect(saldoUtil({ produto: { id: 1 } })).toBeNull();
  });
});

describe('emLotes', () => {
  it('quebra em blocos de 100, que é o teto medido da URL', () => {
    const ids = Array.from({ length: 250 }, (_, i) => i);
    const lotes = emLotes(ids);
    expect(lotes.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(POR_LOTE).toBe(100);
  });

  it('lista vazia não gera lote nenhum', () => {
    expect(emLotes([])).toEqual([]);
  });
});

describe('porProduto', () => {
  it('indexa pelo id do produto', () => {
    const mapa = porProduto([saldo(1), { produto: { id: 99 }, saldoVirtualTotal: 3 }]);
    expect(mapa.get(99)?.saldoVirtualTotal).toBe(3);
  });

  it('descarta entrada sem id em vez de quebrar', () => {
    expect(porProduto([{ produto: {} } as any]).size).toBe(0);
  });
});
