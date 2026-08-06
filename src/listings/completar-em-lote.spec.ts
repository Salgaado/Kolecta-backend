import { faltando, montarPatch, lerAtributos, vazio } from './completar-em-lote';

/**
 * Completar em massa nasceu da importação do Bling: o ERP entrega o suficiente
 * para publicar, mas linha, ano e edição ficam vazios, e são eles que alimentam
 * a busca e os filtros. O anúncio entra no ar e some da navegação.
 *
 * A regra que sustenta tudo: PREENCHE O QUE ESTÁ VAZIO, não sobrescreve.
 */
describe('faltando', () => {
  it('aponta coluna vazia e atributo vazio', () => {
    const a = { brand: 'Hot Wheels', line: '', attributes: '{"jogo":""}' };
    expect(faltando(a, ['brand', 'line', 'jogo'])).toEqual(['line', 'jogo']);
  });

  it('espaço em branco conta como vazio', () => {
    expect(faltando({ line: '   ' }, ['line'])).toEqual(['line']);
  });

  it('anúncio completo não falta nada', () => {
    const a = { brand: 'Bburago', line: 'Race', attributes: '{"jogo":"F1"}' };
    expect(faltando(a, ['brand', 'line', 'jogo'])).toEqual([]);
  });

  it('attributes corrompido não quebra, conta como vazio', () => {
    expect(faltando({ attributes: 'isso não é json' }, ['jogo'])).toEqual(['jogo']);
  });
});

describe('montarPatch', () => {
  it('preenche o vazio e NÃO toca no que já tem valor', () => {
    // Aplicar "Mainline" a cinquenta anúncios não pode apagar o "Car Culture"
    // que três deles já tinham certo.
    const a = { line: 'Car Culture', year: '' };
    const p = montarPatch(a, { line: 'Mainline', year: '2024' });
    expect(p!.colunas).toEqual({ year: '2024' });
  });

  it('sobrescreve quando pedido explicitamente', () => {
    // O caso legítimo é corrigir em massa: o vendedor digitou errado em trinta.
    const a = { line: 'Car Culture' };
    const p = montarPatch(a, { line: 'Mainline' }, true);
    expect(p!.colunas).toEqual({ line: 'Mainline' });
  });

  it('valor vazio não apaga nada', () => {
    // Campo em branco na tela significa "não mexe", não "limpa".
    const a = { line: 'Mainline' };
    expect(montarPatch(a, { line: '' })).toBeNull();
    expect(montarPatch(a, { line: '   ' })).toBeNull();
  });

  it('devolve null quando nada mudaria, para não gastar UPDATE à toa', () => {
    const a = { line: 'Mainline', year: '2024' };
    expect(montarPatch(a, { line: 'Outra', year: '1999' })).toBeNull();
  });

  it('mexe nos atributos preservando o que já estava lá', () => {
    const a = { attributes: '{"jogo":"Pokemon","raridade":"Rara"}' };
    const p = montarPatch(a, { numero: '025' });
    const attrs = lerAtributos(p!.attributes);
    expect(attrs).toEqual({ jogo: 'Pokemon', raridade: 'Rara', numero: '025' });
  });

  it('não regrava attributes quando só as colunas mudaram', () => {
    // Regravar o JSON idêntico seria escrita à toa e mexeria no updatedAt.
    const a = { line: '', attributes: '{"jogo":"Pokemon"}' };
    const p = montarPatch(a, { line: 'Mainline' });
    expect(p!.attributes).toBeNull();
    expect(p!.colunas).toEqual({ line: 'Mainline' });
  });

  it('campo desconhecido vai para attributes, não vira coluna', () => {
    const p = montarPatch({}, { personagem: 'Goku' });
    expect(p!.colunas).toEqual({});
    expect(lerAtributos(p!.attributes)).toEqual({ personagem: 'Goku' });
  });
});

describe('vazio', () => {
  it('null, undefined e espaço contam como vazio', () => {
    expect(vazio(null)).toBe(true);
    expect(vazio(undefined)).toBe(true);
    expect(vazio('  ')).toBe(true);
    expect(vazio('x')).toBe(false);
  });
});
