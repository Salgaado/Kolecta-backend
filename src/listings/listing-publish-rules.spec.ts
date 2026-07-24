import {
  listingPublishBlockers,
  type ListingPublishFields,
} from './listing-publish-rules';

// Anúncio direto completo (passa na peneira base).
const validDirect: ListingPublishFields = {
  type: 'direct',
  title: 'Hot Wheels RLC Skyline',
  description: 'Descrição bem completa do item colecionável raro e lacrado.',
  priceInCents: 50000,
  images: JSON.stringify(['a.jpg', 'b.jpg', 'c.jpg']),
  categoryId: 'cat_1',
  condition: 'lacrado',
  weightGrams: 200,
  widthCm: 10,
  heightCm: 10,
  lengthCm: 10,
};

describe('listingPublishBlockers', () => {
  it('não retorna bloqueios para um anúncio direto completo', () => {
    expect(listingPublishBlockers(validDirect)).toEqual([]);
  });

  // ── Título mínimo (1.3) ──
  it('bloqueia título com menos de 10 caracteres', () => {
    const missing = listingPublishBlockers({ ...validDirect, title: 'curto' });
    expect(missing).toContain('Título com pelo menos 10 caracteres');
  });

  it('bloqueia título ausente', () => {
    const missing = listingPublishBlockers({ ...validDirect, title: null });
    expect(missing).toContain('Título com pelo menos 10 caracteres');
  });

  // ── Reserva ≥ lance inicial (1.3, leilão) ──
  it('bloqueia reserva menor que o lance inicial', () => {
    const missing = listingPublishBlockers(
      { ...validDirect, type: 'auction', priceInCents: null },
      5000,
      { reservePriceInCents: 3000 },
    );
    expect(missing).toContain(
      'Preço de reserva não pode ser menor que o lance inicial',
    );
  });

  it('não bloqueia reserva ≥ lance inicial', () => {
    const missing = listingPublishBlockers(
      { ...validDirect, type: 'auction', priceInCents: null },
      5000,
      { reservePriceInCents: 6000 },
    );
    expect(missing).not.toContain(
      'Preço de reserva não pode ser menor que o lance inicial',
    );
  });

  // ── Campos obrigatórios por categoria (1.3) ──
  it('bloqueia marca e escala faltando em miniaturas-diecast', () => {
    const missing = listingPublishBlockers(
      { ...validDirect, brand: null, scale: null },
      undefined,
      { categorySlug: 'miniaturas-diecast' },
    );
    expect(missing).toContain('Fabricante da miniatura');
    expect(missing).toContain('Escala');
  });

  it('aceita miniaturas-diecast com marca e escala (colunas próprias)', () => {
    const missing = listingPublishBlockers(
      { ...validDirect, brand: 'Hot Wheels', scale: '1:64' },
      undefined,
      { categorySlug: 'miniaturas-diecast' },
    );
    expect(missing).not.toContain('Fabricante da miniatura');
    expect(missing).not.toContain('Escala');
  });

  it('bloqueia "jogo" faltando em cards-colecionaveis (via attributes)', () => {
    const missing = listingPublishBlockers(
      { ...validDirect, attributes: JSON.stringify({ raridade: 'Rara' }) },
      undefined,
      { categorySlug: 'cards-colecionaveis' },
    );
    expect(missing).toContain('Jogo / Universo');
  });

  it('aceita cards-colecionaveis com "jogo" preenchido no attributes', () => {
    const missing = listingPublishBlockers(
      { ...validDirect, attributes: JSON.stringify({ jogo: 'Pokémon' }) },
      undefined,
      { categorySlug: 'cards-colecionaveis' },
    );
    expect(missing).not.toContain('Jogo / Universo');
  });

  it('ignora campos por categoria quando o slug é desconhecido (compat script)', () => {
    // Sem categorySlug no contexto, a peneira não checa campos de categoria.
    const missing = listingPublishBlockers({ ...validDirect, brand: null });
    expect(missing).toEqual([]);
  });
});
