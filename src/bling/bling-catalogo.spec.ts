import {
  normalizarProduto,
  fotosDoProduto,
  pesoEmGramas,
  dimensoesEmCm,
  descricaoDoProduto,
  produtoParaLinha,
} from './bling-catalogo';

/**
 * Contrato conferido contra a API v3 do Bling em 05/08/2026. Os nomes de campo
 * vêm de lá, não de suposição: `GET /produtos` traz o básico e `GET
 * /produtos/{id}` acrescenta peso, dimensões, GTIN e as fotos extras.
 */
describe('fotosDoProduto', () => {
  it('não conta a mesma foto duas vezes', () => {
    // A principal costuma aparecer TAMBÉM nas externas. Somar as duas daria
    // "2 fotos" para um produto que só tem uma, e o anúncio passaria na
    // validação (mínimo 2) exibindo a mesma imagem repetida.
    const fotos = fotosDoProduto({
      imagemURL: 'https://cdn/foto1.jpg',
      midia: { imagens: { externas: [{ link: 'https://cdn/foto1.jpg' }] } },
    });
    expect(fotos).toEqual(['https://cdn/foto1.jpg']);
  });

  it('ignora a query string ao comparar', () => {
    const fotos = fotosDoProduto({
      imagemURL: 'https://cdn/foto1.jpg',
      midia: { imagens: { externas: [{ link: 'https://cdn/foto1.jpg?v=2' }] } },
    });
    expect(fotos).toHaveLength(1);
  });

  it('junta principal e externas quando são diferentes', () => {
    const fotos = fotosDoProduto({
      imagemURL: 'https://cdn/a.jpg',
      midia: { imagens: { externas: [{ link: 'https://cdn/b.jpg' }, { link: 'nao-e-url' }] } },
    });
    expect(fotos).toEqual(['https://cdn/a.jpg', 'https://cdn/b.jpg']);
  });

  it('produto sem foto devolve lista vazia, não quebra', () => {
    expect(fotosDoProduto({})).toEqual([]);
    expect(fotosDoProduto(null)).toEqual([]);
  });
});

describe('pesoEmGramas', () => {
  it('prefere o peso BRUTO, que é o do produto embalado', () => {
    // Os Correios pesam a caixa, não a peça.
    expect(pesoEmGramas({ pesoLiquido: 0.1, pesoBruto: 0.25 })).toBe(250);
  });

  it('cai no líquido quando não há bruto', () => {
    expect(pesoEmGramas({ pesoLiquido: 0.08 })).toBe(80);
  });

  it('sem peso devolve null, para a validação apontar', () => {
    expect(pesoEmGramas({})).toBeNull();
    expect(pesoEmGramas({ pesoBruto: 0 })).toBeNull();
  });
});

describe('dimensoesEmCm', () => {
  it('unidadeMedida 1 é CENTÍMETRO, não metro', () => {
    // Eu tinha mapeado 1 como metros, e o erro custava dinheiro: as medidas
    // iriam multiplicadas por 100 e o frete seria cotado sobre uma caixa cem
    // vezes maior. Os dados reais das duas lojas conectadas em 06/08/2026 são
    // todos `unidadeMedida: 1`, com 20x20x20 e 10x15x30 para miniatura 1:64.
    expect(dimensoesEmCm({ dimensoes: { largura: 20, altura: 20, profundidade: 20, unidadeMedida: 1 } }))
      .toEqual({ largura: 20, altura: 20, comprimento: 20 });
    expect(dimensoesEmCm({ dimensoes: { largura: 10, altura: 15, profundidade: 30, unidadeMedida: 1 } }))
      .toEqual({ largura: 10, altura: 15, comprimento: 30 });
  });

  it('unidade ausente ou desconhecida também é cm, que é o lado seguro', () => {
    // Errar para menos numa unidade rara é melhor do que inflar cem vezes.
    expect(dimensoesEmCm({ dimensoes: { largura: 16, altura: 6, profundidade: 12 } }))
      .toEqual({ largura: 16, altura: 6, comprimento: 12 });
    expect(dimensoesEmCm({ dimensoes: { largura: 16, altura: 6, profundidade: 12, unidadeMedida: 9 } }))
      .toEqual({ largura: 16, altura: 6, comprimento: 12 });
  });
});

describe('descricaoDoProduto', () => {
  it('limpa o HTML do editor do Bling', () => {
    const d = descricaoDoProduto({
      descricaoCurta: 'curta',
      descricaoComplementar: '<p>Miniatura <b>lacrada</b></p><br>Nunca aberta&nbsp;aqui.',
    });
    expect(d).not.toContain('<');
    expect(d).toContain('Miniatura lacrada');
    expect(d).toContain('Nunca aberta aqui.');
  });

  it('fica com a curta quando a complementar é menor', () => {
    expect(descricaoDoProduto({ descricaoCurta: 'texto bem mais longo aqui', descricaoComplementar: 'oi' }))
      .toBe('texto bem mais longo aqui');
  });
});

describe('produtoParaLinha', () => {
  const detalhe = {
    id: 42,
    nome: 'Hot Wheels Nissan Skyline GT-R R34',
    codigo: 'HW-R34',
    preco: 149.9,
    gtin: '7891234567890',
    marca: 'Hot Wheels',
    pesoBruto: 0.12,
    dimensoes: { largura: 16, altura: 6, profundidade: 12, unidadeMedida: 2 },
    descricaoCurta: 'Miniatura lacrada, nunca aberta, direto da caixa.',
    imagemURL: 'https://cdn/a.jpg',
    midia: { imagens: { externas: [{ link: 'https://cdn/b.jpg' }] } },
  };

  it('sai no formato da planilha, para passar pela mesma validação', () => {
    const l = produtoParaLinha(detalhe, { categoria: 'miniaturas-diecast', condicao: 'novo-lacrado' });
    expect(l.title).toBe('Hot Wheels Nissan Skyline GT-R R34');
    expect(l.price).toBe('149.9');
    expect(l.images).toBe('https://cdn/a.jpg,https://cdn/b.jpg');
    expect(l.weight_grams).toBe('120');
    expect(l.width_cm).toBe('16');
    expect(l.sku).toBe('HW-R34');
    expect(l.gtin).toBe('7891234567890');
  });

  it('categoria e condição vêm de fora: o Bling não tem esses campos', () => {
    const l = produtoParaLinha(detalhe, { categoria: 'action-figures', condicao: 'usado-conservado' });
    expect(l.category).toBe('action-figures');
    expect(l.condition).toBe('usado-conservado');
  });

  it('deixa vazio o que o ERP não guarda, para a conferência apontar', () => {
    const l = produtoParaLinha(detalhe, { categoria: 'miniaturas-diecast', condicao: 'novo-lacrado' });
    expect(l.scale).toBe('');
    expect(l.personagem).toBe('');
  });
});

describe('normalizarProduto', () => {
  it('lê a listagem barata sem quebrar em campo ausente', () => {
    const p = normalizarProduto({ id: 7, nome: ' Item ', codigo: 'SKU1', preco: 10, situacao: 'A' });
    expect(p).toEqual({
      id: 7, nome: 'Item', sku: 'SKU1', precoEmReais: 10,
      estoque: null, imagem: null, ativo: true,
    });
  });

  it('produto inativo no ERP vem marcado', () => {
    expect(normalizarProduto({ id: 1, nome: 'x', situacao: 'I' }).ativo).toBe(false);
  });
});
