import {
  saldoUtil,
  decidir,
  emLotes,
  porProduto,
  POR_LOTE,
  type AnuncioParaSincronizar,
} from './estoque-sync';

/**
 * O que estes testes prendem são as decisões que doem quando erram: tirar do ar
 * o que devia continuar vendendo, e republicar o que o lojista tirou de
 * propósito.
 */

const anuncio = (over: Partial<AnuncioParaSincronizar> = {}): AnuncioParaSincronizar => ({
  id: 'l1',
  blingProductId: 16654609068,
  type: 'direct',
  status: 'active',
  stock: 3,
  pausedByStock: false,
  ...over,
});

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

describe('decidir', () => {
  it('atualiza o estoque quando o saldo mudou', () => {
    expect(decidir(anuncio({ stock: 3 }), saldo(7))).toEqual({
      id: 'l1', stock: 7, motivo: 'saldo',
    });
  });

  it('não faz nada quando o saldo é o mesmo', () => {
    // Sem isso, a rodada de meia em meia hora carimbaria updatedAt no catálogo
    // inteiro e embaralharia a vitrine, que ordena por atualização.
    expect(decidir(anuncio({ stock: 3 }), saldo(3))).toBeNull();
  });

  it('zerou no ERP: tira do ar como pausado, marcando que foi o estoque', () => {
    expect(decidir(anuncio({ status: 'active', stock: 2 }), saldo(0))).toEqual({
      id: 'l1', stock: 0, status: 'paused', pausedByStock: true, motivo: 'zerou',
    });
  });

  it('voltou a ter peça: reativa o que a falta de estoque tinha pausado', () => {
    expect(
      decidir(anuncio({ status: 'paused', stock: 0, pausedByStock: true }), saldo(4)),
    ).toEqual({
      id: 'l1', stock: 4, status: 'active', pausedByStock: false, motivo: 'voltou',
    });
  });

  it('NÃO reativa o que o lojista pausou na mão, só corrige o saldo', () => {
    expect(
      decidir(anuncio({ status: 'paused', stock: 0, pausedByStock: false }), saldo(4)),
    ).toEqual({ id: 'l1', stock: 4, motivo: 'saldo' });
  });

  it('produto que o Bling não devolveu não zera nada', () => {
    // Ausência é "não sei", e zerar por ausência tiraria do ar anúncio saudável
    // só porque o produto saiu do lote ou foi apagado no ERP.
    expect(decidir(anuncio({ stock: 5 }), undefined)).toBeNull();
  });

  it('não toca em leilão', () => {
    // Uma peça, prazo correndo e lances dados: não pode sumir por baixo de quem
    // já deu lance porque o lojista mexeu no ERP.
    expect(decidir(anuncio({ type: 'auction', stock: 1 }), saldo(0))).toBeNull();
  });

  it('não toca no que a moderação recusou nem no vendido', () => {
    for (const status of ['rejected', 'cancelled', 'sold']) {
      expect(decidir(anuncio({ status, stock: 0 }), saldo(9))).toBeNull();
    }
  });

  it('atualiza estoque de anúncio em análise sem mudar o status', () => {
    expect(decidir(anuncio({ status: 'pending_review', stock: 1 }), saldo(6))).toEqual({
      id: 'l1', stock: 6, motivo: 'saldo',
    });
    // E zerar em análise não vira "paused": ele nem chegou a estar no ar.
    expect(decidir(anuncio({ status: 'pending_review', stock: 1 }), saldo(0))).toEqual({
      id: 'l1', stock: 0, motivo: 'saldo',
    });
  });

  it('ignora anúncio que não veio do Bling', () => {
    expect(decidir(anuncio({ blingProductId: null }), saldo(0))).toBeNull();
  });

  it('estoque nulo (nunca informado) recebe o saldo do ERP', () => {
    expect(decidir(anuncio({ stock: null }), saldo(2))).toEqual({
      id: 'l1', stock: 2, motivo: 'saldo',
    });
  });

  it('pausado com saldo zero segue pausado, sem escrita à toa', () => {
    expect(
      decidir(anuncio({ status: 'paused', stock: 0, pausedByStock: true }), saldo(0)),
    ).toBeNull();
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
