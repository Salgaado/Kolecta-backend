import {
  normalizarProduto,
  fotosDoProduto,
  pesoEmGramas,
  dimensoesEmCm,
  descricaoDoProduto,
  escalaNoTitulo,
  produtoParaLinha,
} from './bling-catalogo';

/**
 * Escala deduzida do título.
 *
 * O Bling não tem esse campo, então antes ela vinha do padrão do lote, igual
 * para todos. Isso quebra em catálogo misto: quem tem 1:64 e 1:18 no mesmo lote
 * marcaria tudo errado.
 *
 * Os títulos abaixo são reais, das duas lojas conectadas em 06/08/2026.
 */
describe('escalaNoTitulo', () => {
  it('acha nos títulos reais da Escala Miniaturas (76% deles têm)', () => {
    expect(escalaNoTitulo('Miniatura - 1:64 - 2016 Chevrolet Camaro Ss')).toBe('1:64');
    expect(escalaNoTitulo('Miniatura - 1:64 - 1973 Volkswagen Thing Type')).toBe('1:64');
  });

  it('aceita as grafias que aparecem no mundo real', () => {
    expect(escalaNoTitulo('Ferrari F40 1/18 Bburago')).toBe('1:18');
    expect(escalaNoTitulo('Porsche 911 escala 1-43')).toBe('1:43');
    expect(escalaNoTitulo('Camaro 1 : 24 lacrado')).toBe('1:24');
  });

  it('devolve null quando o título não diz, como na MF Minis', () => {
    // Lá só 2% dos títulos trazem escala; o padrão do lote é que cobre.
    expect(escalaNoTitulo('[Pré-venda] - Tarmac Works - RWB 993 Carrera')).toBeNull();
    expect(escalaNoTitulo('Hot Wheels 2020 Corvette STH')).toBeNull();
  });

  it('não inventa escala a partir de número solto', () => {
    // "1:5" e "1:100" não são escala de miniatura. Aceitar qualquer número
    // encheria o campo de lixo, que é pior do que deixar vazio.
    expect(escalaNoTitulo('Kit 1:5 de reparo')).toBeNull();
    expect(escalaNoTitulo('Mapa 1:100000')).toBeNull();
    expect(escalaNoTitulo('')).toBeNull();
    expect(escalaNoTitulo(null)).toBeNull();
  });
});

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

  it('limpa o HTML do Word na descricaoCurta (caso real do print)', () => {
    // Byte a byte do produto MGT01118A (Toleman/Senna). A curta vinha do Word,
    // com `<p class="MsoNoSpacing">` e `<br />`, e ia crua para o anúncio porque
    // era mais longa que a complementar limpa ("Mini GT").
    const d = descricaoDoProduto({
      descricaoCurta:
        '<p class="MsoNoSpacing">Toleman TG184 #19 Ayrton Senna 1984 Monaco Grand Prix 2nd Place - Mini GT -1:64<br />Produto novo, lacrado na embalagem original<br />Miniatura em escala 1:64</p>',
      descricaoComplementar: '<p>Mini GT</p>',
    });
    expect(d).not.toContain('<');
    expect(d).not.toContain('MsoNoSpacing');
    expect(d).toContain('Toleman TG184 #19 Ayrton Senna');
    expect(d).toContain('lacrado na embalagem original');
    // Cada <br /> virou quebra de linha de verdade.
    expect(d.split('\n').length).toBeGreaterThanOrEqual(3);
  });

  it('remove comentário condicional e bloco de estilo do Word', () => {
    const d = descricaoDoProduto({
      descricaoCurta:
        '<!--[if gte mso 9]><xml>lixo</xml><![endif]--><style>.x{color:red}</style><p>Peça <span style="font-weight:bold">rara</span> aqui</p>',
      descricaoComplementar: '',
    });
    expect(d).toBe('Peça rara aqui');
  });

  it('descrição vazia nos dois campos não quebra', () => {
    expect(descricaoDoProduto({})).toBe('');
    expect(descricaoDoProduto({ descricaoCurta: null, descricaoComplementar: undefined })).toBe('');
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

  it('a escala do TÍTULO ganha do padrão do lote', () => {
    // Catálogo misto é a razão de existir: com 1:64 e 1:18 no mesmo lote, um
    // padrão único marcaria metade errado.
    const l = produtoParaLinha(
      { ...detalhe, nome: 'Bburago 1:18 Ferrari F40' },
      { categoria: 'miniaturas-diecast', condicao: 'novo-lacrado', atributos: { scale: '1:64' } },
    );
    expect(l.scale).toBe('1:18');
  });

  it('o padrão do lote cobre quando o título não diz', () => {
    const l = produtoParaLinha(detalhe, {
      categoria: 'miniaturas-diecast',
      condicao: 'novo-lacrado',
      atributos: { scale: '1:64' },
    });
    expect(l.scale).toBe('1:64');
  });

  it('a marca do ERP ganha do padrão do lote', () => {
    // Sobrescrever apagaria dado bom do Bling em nome de uma escolha feita para
    // o lote inteiro.
    const l = produtoParaLinha(detalhe, {
      categoria: 'miniaturas-diecast',
      condicao: 'novo-lacrado',
      atributos: { brand: 'Outra Marca' },
    });
    expect(l.brand).toBe('Hot Wheels');
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
