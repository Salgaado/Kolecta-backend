import {
  decidir,
  normalizarSaldo,
  type AnuncioParaSincronizar,
} from './estoque-sync';

/**
 * O que estes testes prendem são as decisões que doem quando erram: tirar do ar
 * o que devia continuar vendendo, e republicar o que o lojista tirou de
 * propósito.
 *
 * Eles vieram de `bling/estoque-sync.spec.ts` quando as regras saíram de lá
 * para servir também ao Tiny. As asserções são as mesmas: o que muda de ERP
 * para ERP é o formato do saldo, não a decisão.
 */

const anuncio = (
  over: Partial<AnuncioParaSincronizar> = {},
): AnuncioParaSincronizar => ({
  id: 'l1',
  erpProductId: 16654609068,
  type: 'direct',
  status: 'active',
  stock: 3,
  pausedByStock: false,
  ...over,
});

describe('normalizarSaldo', () => {
  it('negativo vira zero (catálogo real tem produto com -4)', () => {
    expect(normalizarSaldo(-4)).toBe(0);
  });

  it('trunca fração: o Tiny devolve saldo como float', () => {
    // `saldo`, `reservado` e `disponivel` são `number/format: float` no Swagger
    // da Olist. Meia miniatura não existe, e meio anúncio muito menos.
    expect(normalizarSaldo(2.7)).toBe(2);
  });

  it('o que não é número vira null, e não zero', () => {
    // A diferença importa: null é "não sei", e quem não sabe não tira do ar.
    expect(normalizarSaldo(undefined)).toBeNull();
    expect(normalizarSaldo(null)).toBeNull();
    expect(normalizarSaldo('3')).toBeNull();
    expect(normalizarSaldo(NaN)).toBeNull();
  });
});

describe('decidir', () => {
  it('atualiza o estoque quando o saldo mudou', () => {
    expect(decidir(anuncio({ stock: 3 }), 7)).toEqual({
      id: 'l1',
      stock: 7,
      motivo: 'saldo',
    });
  });

  it('não faz nada quando o saldo é o mesmo', () => {
    // Sem isso, a rodada de meia em meia hora carimbaria updatedAt no catálogo
    // inteiro e embaralharia a vitrine, que ordena por atualização.
    expect(decidir(anuncio({ stock: 3 }), 3)).toBeNull();
  });

  it('zerou no ERP: tira do ar como pausado, marcando que foi o estoque', () => {
    expect(decidir(anuncio({ status: 'active', stock: 2 }), 0)).toEqual({
      id: 'l1',
      stock: 0,
      status: 'paused',
      pausedByStock: true,
      motivo: 'zerou',
    });
  });

  it('voltou a ter peça: reativa o que a falta de estoque tinha pausado', () => {
    expect(
      decidir(anuncio({ status: 'paused', stock: 0, pausedByStock: true }), 4),
    ).toEqual({
      id: 'l1',
      stock: 4,
      status: 'active',
      pausedByStock: false,
      motivo: 'voltou',
    });
  });

  it('NÃO reativa o que o lojista pausou na mão, só corrige o saldo', () => {
    expect(
      decidir(anuncio({ status: 'paused', stock: 0, pausedByStock: false }), 4),
    ).toEqual({ id: 'l1', stock: 4, motivo: 'saldo' });
  });

  it('produto que o ERP não devolveu não zera nada', () => {
    // Ausência é "não sei", e zerar por ausência tiraria do ar anúncio saudável
    // só porque o produto saiu do lote ou foi apagado no ERP.
    expect(decidir(anuncio({ stock: 5 }), undefined)).toBeNull();
    expect(decidir(anuncio({ stock: 5 }), null)).toBeNull();
  });

  it('não toca em leilão', () => {
    // Uma peça, prazo correndo e lances dados: não pode sumir por baixo de quem
    // já deu lance porque o lojista mexeu no ERP.
    expect(decidir(anuncio({ type: 'auction', stock: 1 }), 0)).toBeNull();
  });

  it('não toca no que a moderação recusou nem no vendido', () => {
    for (const status of ['rejected', 'cancelled', 'sold']) {
      expect(decidir(anuncio({ status, stock: 0 }), 9)).toBeNull();
    }
  });

  it('atualiza estoque de anúncio em análise sem mudar o status', () => {
    expect(decidir(anuncio({ status: 'pending_review', stock: 1 }), 6)).toEqual(
      {
        id: 'l1',
        stock: 6,
        motivo: 'saldo',
      },
    );
    // E zerar em análise não vira "paused": ele nem chegou a estar no ar.
    expect(decidir(anuncio({ status: 'pending_review', stock: 1 }), 0)).toEqual(
      {
        id: 'l1',
        stock: 0,
        motivo: 'saldo',
      },
    );
  });

  it('ignora anúncio que não veio de ERP nenhum', () => {
    expect(decidir(anuncio({ erpProductId: null }), 0)).toBeNull();
  });

  it('estoque nulo (nunca informado) recebe o saldo do ERP', () => {
    expect(decidir(anuncio({ stock: null }), 2)).toEqual({
      id: 'l1',
      stock: 2,
      motivo: 'saldo',
    });
  });

  it('pausado com saldo zero segue pausado, sem escrita à toa', () => {
    expect(
      decidir(anuncio({ status: 'paused', stock: 0, pausedByStock: true }), 0),
    ).toBeNull();
  });
});
