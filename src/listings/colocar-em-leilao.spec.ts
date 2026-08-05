import { decidirAcao, copiarCampos, normalizarConfig } from './colocar-em-leilao';

describe('decidirAcao', () => {
  it('peça única CONVERTE, para não existirem dois anúncios do mesmo objeto', () => {
    // 88% do catálogo é estoque 1. Duplicar aqui deixaria o vendedor vender o
    // mesmo item duas vezes, que vira disputa e estorno.
    expect(decidirAcao({ type: 'direct', stock: 1 }).acao).toBe('converter');
  });

  it('estoque nulo ou zero conta como peça única', () => {
    // Anúncio antigo entrou sem estoque e o vendedor sempre tratou como um.
    expect(decidirAcao({ type: 'direct', stock: null }).acao).toBe('converter');
    expect(decidirAcao({ type: 'direct', stock: 0 }).acao).toBe('converter');
  });

  it('com várias unidades DUPLICA, para ele seguir vendendo o resto', () => {
    expect(decidirAcao({ type: 'direct', stock: 3 }).acao).toBe('duplicar');
  });

  it('recusa anúncio que já é leilão', () => {
    const r = decidirAcao({ type: 'auction', stock: 1 });
    expect(r.acao).toBeNull();
    expect(r.motivo).toMatch(/já é um leilão/);
  });

  it('recusa quando existe pedido em aberto', () => {
    // A peça já tem dono. Leiloar por cima seria vender de novo o que saiu.
    for (const status of ['pending', 'pending_payment', 'paid', 'shipped']) {
      const r = decidirAcao({ type: 'direct', stock: 1, statusDosPedidos: [status] });
      expect(r.acao).toBeNull();
      expect(r.motivo).toMatch(/pedido em aberto/);
    }
  });

  it('pedido cancelado ou entregue não impede', () => {
    expect(decidirAcao({ type: 'direct', stock: 1, statusDosPedidos: ['cancelled', 'delivered'] }).acao)
      .toBe('converter');
  });
});

describe('copiarCampos', () => {
  const origem = {
    categoryId: 'cat1', title: 'Hot Wheels R34', description: 'texto',
    images: '["a","b"]', weightGrams: 120, condition: 'novo-lacrado',
    // Estes NÃO podem viajar:
    id: 'antigo', sellerId: 's1', status: 'active', type: 'direct',
    priceInCents: 14990, stock: 5, blingProductId: 42,
    featuredUntil: 'depois', featuredSource: 'fundador',
    rejectionReason: 'motivo antigo', moderatedBy: 'admin', moderatedAt: 'ontem',
  };

  it('leva o conteúdo do anúncio', () => {
    const c = copiarCampos(origem);
    expect(c.title).toBe('Hot Wheels R34');
    expect(c.images).toBe('["a","b"]');
    expect(c.weightGrams).toBe(120);
    expect(c.condition).toBe('novo-lacrado');
  });

  it('NÃO leva o vínculo com o Bling', () => {
    // O índice único é (vendedor, produto do Bling). Copiar estouraria na
    // segunda cópia e derrubaria a duplicação inteira.
    expect(copiarCampos(origem)).not.toHaveProperty('blingProductId');
  });

  it('NÃO leva destaque, moderação, preço, estoque nem identidade', () => {
    const c = copiarCampos(origem);
    for (const proibido of [
      'id', 'sellerId', 'status', 'type', 'priceInCents', 'stock',
      'featuredUntil', 'featuredSource', 'rejectionReason', 'moderatedBy', 'moderatedAt',
    ]) {
      expect(c).not.toHaveProperty(proibido);
    }
  });
});

describe('normalizarConfig', () => {
  it('usa os mesmos padrões do wizard quando o campo vem vazio', () => {
    expect(normalizarConfig({ startingBidInCents: 5000 })).toEqual({
      startingBidInCents: 5000,
      minIncrementInCents: 1000,
      reservePriceInCents: null,
      durationHours: 48,
      antiSniper: true,
    });
  });

  it('respeita o que o vendedor escolheu, inclusive anti-sniper desligado', () => {
    const c = normalizarConfig({
      startingBidInCents: 100, minIncrementInCents: 500,
      reservePriceInCents: 9000, durationHours: 336, antiSniper: false,
    });
    expect(c.antiSniper).toBe(false);
    expect(c.durationHours).toBe(336);
  });
});
