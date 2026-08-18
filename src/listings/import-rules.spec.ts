import {
  MAX_IMAGES,
  isInstructionRow,
  validateImportRow,
  mapImportRow,
  parsePrice,
  parsePhotos,
} from './import-rules';

/** Linha completa e válida de miniatura — base dos testes. */
const linhaOk = (over: Record<string, string> = {}) => ({
  title: 'Hot Wheels Nissan Skyline GT-R R34 Premium',
  category: 'miniaturas-diecast',
  condition: 'novo-lacrado',
  description: 'Lacrado, nunca aberto. Guardado em caixa desde 2023.',
  price: '149.90',
  images: 'https://s.com/1.jpg,https://s.com/2.jpg,https://s.com/3.jpg',
  brand: 'Hot Wheels',
  scale: '1:64',
  weight_grams: '150',
  width_cm: '15',
  height_cm: '10',
  length_cm: '5',
  ...over,
});

describe('import-rules', () => {
  describe('isInstructionRow', () => {
    // O modelo traz duas linhas de instrução abaixo do cabeçalho. Sem descartar,
    // cada importação criaria dois anúncios de lixo.
    it('descarta a linha de rótulos do modelo', () => {
      expect(isInstructionRow({ title: 'Título *' })).toBe(true);
    });

    it('descarta a linha de ajuda do modelo', () => {
      expect(isInstructionRow({ title: 'Mínimo 10 caracteres' })).toBe(true);
    });

    it('descarta linha vazia', () => {
      expect(isInstructionRow({ title: '   ' })).toBe(true);
    });

    it('mantém uma linha de verdade', () => {
      expect(isInstructionRow(linhaOk())).toBe(false);
    });
  });

  describe('parsePrice', () => {
    it.each([
      ['149.90', 149.9],
      ['149,90', 149.9],
      ['R$ 149,90', 149.9],
      ['1.299,90', 1299.9],
    ])('lê %s', (bruto, esperado) => {
      expect(parsePrice(bruto)).toBeCloseTo(esperado, 2);
    });

    it.each(['', '0', 'abc', '-10'])('rejeita %s', (bruto) => {
      expect(parsePrice(bruto)).toBeNull();
    });
  });

  describe('parsePhotos', () => {
    it('descarta o que não for link', () => {
      expect(
        parsePhotos('https://a.com/1.jpg, foto2, https://a.com/3.jpg'),
      ).toEqual(['https://a.com/1.jpg', 'https://a.com/3.jpg']);
    });
  });

  describe('validateImportRow', () => {
    const campos = (row: Record<string, string>) =>
      validateImportRow(row, 2).map((e) => e.campo);

    it('linha completa passa sem erro', () => {
      expect(validateImportRow(linhaOk(), 2)).toEqual([]);
    });

    it('exige categoria — a causa raiz dos anúncios órfãos', () => {
      expect(campos(linhaOk({ category: '' }))).toContain('category');
    });

    it('rejeita categoria desconhecida', () => {
      expect(campos(linhaOk({ category: 'brinquedos' }))).toContain('category');
    });

    it('rejeita o vocabulário antigo de condição', () => {
      // 'usado', 'lacrado' e 'mint' saíram; aceitar isso foi o que deixou
      // centenas de anúncios com condição que a vitrine não sabe exibir.
      expect(campos(linhaOk({ condition: 'usado' }))).toContain('condition');
    });

    it('exige peso e as três dimensões', () => {
      const erros = campos(
        linhaOk({ weight_grams: '', width_cm: '0', height_cm: 'x' }),
      );
      expect(erros).toEqual(
        expect.arrayContaining(['weight_grams', 'width_cm', 'height_cm']),
      );
    });

    // Foto é OPCIONAL na planilha: os dados entram sem foto e o vendedor anexa
    // as imagens depois. Linha sem foto (ou com poucas) NÃO gera erro.
    it('foto é opcional: linha sem foto não erra', () => {
      expect(campos(linhaOk({ images: '' }))).not.toContain('images');
    });

    it('aceita foto por URL quando informada (fluxo antigo)', () => {
      expect(campos(linhaOk({ images: 'https://a.com/1.jpg' }))).not.toContain('images');
    });

    it(`recusa acima do máximo de ${MAX_IMAGES} fotos`, () => {
      const demais = Array.from(
        { length: MAX_IMAGES + 1 },
        (_, i) => `https://a.com/${i}.jpg`,
      ).join(', ');
      expect(campos(linhaOk({ images: demais }))).toContain('images');
    });

    it('exige os campos da categoria escolhida', () => {
      // miniaturas-diecast exige brand + scale
      expect(campos(linhaOk({ scale: '' }))).toContain('scale');
    });

    it('não cobra campo de categoria quando a categoria é inválida', () => {
      // Senão o vendedor levaria um erro de "escala obrigatória" numa linha cujo
      // problema real é a categoria — ruído em cima de ruído.
      const erros = campos(linhaOk({ category: 'xpto', scale: '' }));
      expect(erros).toContain('category');
      expect(erros).not.toContain('scale');
    });

    it('exige título e descrição mínimos', () => {
      const erros = campos(linhaOk({ title: 'Curto', description: 'Oi' }));
      expect(erros).toEqual(expect.arrayContaining(['title', 'description']));
    });
  });

  describe('mapImportRow', () => {
    it('converte preço para centavos e fotos para JSON', () => {
      const m = mapImportRow(linhaOk({ price: '149,90' }));
      expect(m.priceInCents).toBe(14990);
      expect(JSON.parse(m.images)).toHaveLength(3);
    });

    it('leva peso e dimensões como inteiros', () => {
      const m = mapImportRow(linhaOk());
      expect(m).toMatchObject({
        weightGrams: 150,
        widthCm: 15,
        heightCm: 10,
        lengthCm: 5,
      });
    });

    it('sku vazio vira null (a maioria não usa)', () => {
      expect(mapImportRow(linhaOk()).sku).toBeNull();
      expect(mapImportRow(linhaOk({ sku: 'HW-001' })).sku).toBe('HW-001');
    });

    it('metadado sem coluna própria vai para attributes', () => {
      const m = mapImportRow(
        linhaOk({ category: 'cards-colecionaveis', jogo: 'Pokémon' }),
      );
      expect(JSON.parse(m.attributes!)).toEqual({ jogo: 'Pokémon' });
    });

    it('sem metadado extra, attributes fica null', () => {
      expect(mapImportRow(linhaOk()).attributes).toBeNull();
    });
  });
});
