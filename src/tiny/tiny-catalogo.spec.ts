import {
  normalizarProduto,
  fotosDoProduto,
  pesoEmGramas,
  dimensoesEmCm,
  descricaoDoProduto,
  produtoParaLinha,
} from './tiny-catalogo';

/**
 * Contrato conferido contra o swagger da API v3 do Tiny (erp.tiny.com.br,
 * 08/09/2026), NÃO contra conta real (0 conexões). Os nomes de campo vêm de lá:
 * o NOME do produto mora em `descricao`, o preço em `precos.preco`, o peso e a
 * dimensão em `dimensoes`, as fotos em `anexos[]`.
 */
describe('normalizarProduto (Tiny)', () => {
  it('mapeia os campos da listagem, com o nome vindo de `descricao`', () => {
    const p = normalizarProduto({
      id: 123,
      descricao: 'Miniatura 1:64 Camaro',
      sku: 'ABC-1',
      precos: { preco: 49.9 },
      situacao: 'A',
      estoque: { quantidade: 3 },
      anexos: [{ url: 'https://cdn/1.jpg', externo: true }],
    });
    expect(p).toEqual({
      id: 123,
      nome: 'Miniatura 1:64 Camaro',
      sku: 'ABC-1',
      precoEmReais: 49.9,
      estoque: 3,
      imagem: 'https://cdn/1.jpg',
      ativo: true,
    });
  });

  it('trata inativo/excluído (situacao I/E) como não-ativo', () => {
    expect(normalizarProduto({ id: 1, descricao: 'x', situacao: 'I' }).ativo).toBe(false);
    expect(normalizarProduto({ id: 1, descricao: 'x', situacao: 'E' }).ativo).toBe(false);
  });
});

describe('fotosDoProduto (Tiny)', () => {
  it('lê os anexos e não conta a mesma foto duas vezes', () => {
    const fotos = fotosDoProduto({
      anexos: [
        { url: 'https://cdn/foto1.jpg?sig=a' },
        { url: 'https://cdn/foto1.jpg?sig=b' }, // mesma foto, assinatura diferente
        { url: 'https://cdn/foto2.jpg' },
      ],
    });
    expect(fotos).toEqual(['https://cdn/foto1.jpg?sig=a', 'https://cdn/foto2.jpg']);
  });
});

/**
 * O TETO DE SANIDADE é a blindagem contra a cicatriz do Bling (frete de caixa
 * 100x maior por erro de unidade). Enquanto não há conta real para medir a
 * unidade do Tiny, medida absurda vira vazio para a pendência aparecer na
 * conferência, e não no frete.
 */
describe('teto de sanidade de peso e dimensão', () => {
  it('converte kg -> g e cm no caso normal', () => {
    const d = { dimensoes: { largura: 20, altura: 15, comprimento: 30, pesoBruto: 0.35 } };
    expect(pesoEmGramas(d)).toBe(350);
    expect(dimensoesEmCm(d)).toEqual({ largura: 20, altura: 15, comprimento: 30 });
  });

  it('zera dimensão absurda (provável erro de unidade)', () => {
    // 2000 "cm" = 20 metros: uma caixa de colecionável não chega perto.
    const dim = dimensoesEmCm({ dimensoes: { largura: 2000, altura: 10, comprimento: 10 } });
    expect(dim.largura).toBeNull();
    expect(dim.altura).toBe(10);
  });

  it('zera peso absurdo (provável erro de unidade)', () => {
    // 500 kg de peso bruto num colecionável é erro, não caixa.
    expect(pesoEmGramas({ dimensoes: { pesoBruto: 500 } })).toBeNull();
  });

  it('prefere o peso bruto ao líquido', () => {
    expect(pesoEmGramas({ dimensoes: { pesoBruto: 0.4, pesoLiquido: 0.2 } })).toBe(400);
  });
});

describe('descricaoDoProduto (Tiny)', () => {
  it('fica com a mais rica e limpa o HTML colado do Word', () => {
    const texto = descricaoDoProduto({
      descricao: 'Mini GT',
      descricaoComplementar: '<p class="MsoNoSpacing">Edição limitada.<br/>Lacrada.</p>',
    });
    expect(texto).toBe('Edição limitada.\nLacrada.');
  });
});

describe('produtoParaLinha (Tiny)', () => {
  it('monta a linha no formato da planilha, com escala deduzida do título', () => {
    const linha = produtoParaLinha(
      {
        descricao: 'Miniatura 1:64 Camaro',
        descricaoComplementar: 'Peça nova, lacrada, edição de colecionador.',
        precos: { preco: 89.9 },
        marca: { nome: 'Hot Wheels' },
        gtin: '7891234567890',
        sku: 'HW-1',
        dimensoes: { largura: 10, altura: 5, comprimento: 8, pesoBruto: 0.12 },
        anexos: [{ url: 'https://cdn/a.jpg' }],
      },
      { categoria: 'miniaturas', condicao: 'novo' },
    );
    expect(linha.title).toBe('Miniatura 1:64 Camaro');
    expect(linha.description).toBe('Peça nova, lacrada, edição de colecionador.');
    expect(linha.price).toBe('89.9');
    expect(linha.brand).toBe('Hot Wheels');
    expect(linha.gtin).toBe('7891234567890');
    expect(linha.scale).toBe('1:64');
    expect(linha.weight_grams).toBe('120');
    expect(linha.width_cm).toBe('10');
    expect(linha.images).toBe('https://cdn/a.jpg');
    expect(linha.sku).toBe('HW-1');
  });

  it('preenche do lote sem sobrescrever o que veio do produto', () => {
    const linha = produtoParaLinha(
      { descricao: 'Item sem escala', marca: { nome: 'Marca Real' } },
      { categoria: 'miniaturas', condicao: 'novo', atributos: { scale: '1:18', brand: 'Ignorada' } },
    );
    expect(linha.scale).toBe('1:18'); // veio do lote (produto não tinha)
    expect(linha.brand).toBe('Marca Real'); // do produto ganha do lote
  });
});
