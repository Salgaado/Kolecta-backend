// Tradução de produto do Bling para linha de importação da Kolecta.
//
// PURO, sem Nest e sem banco, para caber em teste sem subir nada. A parte que
// fala HTTP fica no BlingService.
//
// A linha de saída é a MESMA da importação por planilha (ver
// listings/import-rules.ts). Não é coincidência: assim o produto do Bling passa
// exatamente pelas mesmas regras e o vendedor recebe exatamente as mesmas
// mensagens de erro, venha o anúncio de um CSV ou do ERP dele.
//
// Campos verificados contra a API v3 em 05/08/2026:
//   GET /produtos       -> id, nome, codigo, preco, estoque.saldoVirtualTotal,
//                          situacao, imagemURL, descricaoCurta
//   GET /produtos/{id}  -> + pesoLiquido, pesoBruto, gtin, marca, dimensoes,
//                          descricaoComplementar, midia.imagens

/** O que a listagem barata do Bling devolve, já normalizado para a tela. */
export interface ProdutoBling {
  id: number;
  nome: string;
  sku: string | null;
  precoEmReais: number | null;
  estoque: number | null;
  imagem: string | null;
  ativo: boolean;
}

/**
 * Fator de `dimensoes.unidadeMedida` para centímetros.
 *
 * Eu tinha mapeado `1` como METROS. Está errado, e o erro custava dinheiro: as
 * medidas iam multiplicadas por 100 e o frete seria cotado sobre uma caixa cem
 * vezes maior.
 *
 * O que os dados reais mostram (06/08/2026, duas lojas conectadas, 16 produtos
 * conferidos): TODOS trazem `unidadeMedida: 1` com valores como 20x20x20 e
 * 10x15x30 para miniatura 1:64. Em centímetros faz sentido para uma caixa de
 * envio; em metros seria uma caixa de 20 metros.
 *
 * Só há evidência para o valor 1. Qualquer outro cai em centímetros também,
 * que é o padrão do cadastro do Bling e o lado seguro: errar para menos numa
 * unidade rara é melhor do que inflar cem vezes de novo.
 */
const UNIDADE_EM_CM: Readonly<Record<number, number>> = {
  1: 1, // centímetros (confirmado em produção)
};

export function normalizarProduto(p: any): ProdutoBling {
  return {
    id: Number(p?.id),
    nome: String(p?.nome ?? '').trim(),
    sku: textoOuNull(p?.codigo),
    precoEmReais: numeroPositivo(p?.preco),
    // `saldoVirtualTotal` é o saldo considerando pedidos em aberto, que é o que
    // o lojista enxerga no painel dele. Pode vir negativo em venda a descoberto.
    estoque: Number.isFinite(Number(p?.estoque?.saldoVirtualTotal))
      ? Number(p.estoque.saldoVirtualTotal)
      : null,
    imagem: linkValido(p?.imagemURL),
    // 'A' = ativo. Produto inativo no ERP não deveria virar anúncio no ar.
    ativo: String(p?.situacao ?? 'A').toUpperCase() === 'A',
  };
}

/**
 * Todas as fotos do produto, sem repetir.
 *
 * A imagem principal (`imagemURL`) costuma estar TAMBÉM em `midia.imagens
 * .externas`, então juntar as duas sem deduplicar daria "2 fotos" para um
 * produto que só tem uma, e o anúncio passaria na validação com a mesma imagem
 * duas vezes.
 *
 * `internas` ficam de fora: o `linkMiniatura` é thumbnail com validade, e o
 * anexo real exige outra chamada autenticada. Miniatura em anúncio fica ruim.
 */
export function fotosDoProduto(detalhe: any): string[] {
  const brutas = [
    detalhe?.imagemURL,
    ...(Array.isArray(detalhe?.midia?.imagens?.externas)
      ? detalhe.midia.imagens.externas.map((i: any) => i?.link)
      : []),
  ];
  const vistas = new Set<string>();
  const fotos: string[] = [];
  for (const bruta of brutas) {
    const url = linkValido(bruta);
    if (!url) continue;
    const chave = url.split('?')[0].toLowerCase();
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    fotos.push(url);
  }
  return fotos;
}

/**
 * Peso do pacote em gramas.
 *
 * Prefere o peso BRUTO: é o do produto embalado, que é o que os Correios pesam.
 * O líquido é só a peça. Bling grava em quilos.
 */
export function pesoEmGramas(detalhe: any): number | null {
  const kg = numeroPositivo(detalhe?.pesoBruto) ?? numeroPositivo(detalhe?.pesoLiquido);
  return kg === null ? null : Math.round(kg * 1000);
}

/** Dimensões em cm, convertendo da unidade que o Bling gravou. */
export function dimensoesEmCm(detalhe: any): {
  largura: number | null;
  altura: number | null;
  comprimento: number | null;
} {
  const d = detalhe?.dimensoes ?? {};
  const fator = UNIDADE_EM_CM[Number(d?.unidadeMedida)] ?? 1;
  const conv = (v: unknown) => {
    const n = numeroPositivo(v);
    return n === null ? null : Math.round(n * fator);
  };
  return {
    largura: conv(d?.largura),
    altura: conv(d?.altura),
    comprimento: conv(d?.profundidade),
  };
}

/**
 * Descrição do anúncio.
 *
 * A complementar é a rica, mas vem com HTML do editor do Bling e colar tag no
 * anúncio ficaria horrível. A curta é limpa e quase sempre curta demais para os
 * 30 caracteres que a Kolecta exige, então uma completa a outra.
 */
export function descricaoDoProduto(detalhe: any): string {
  const curta = String(detalhe?.descricaoCurta ?? '').trim();
  const complementar = limparHtml(detalhe?.descricaoComplementar);
  if (complementar && complementar.length >= curta.length) return complementar;
  return curta;
}

function limparHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Produto do Bling na forma de linha da planilha de importação.
 *
 * `categoria` e `condicao` vêm de FORA, escolhidos pelo lojista na tela: o Bling
 * não tem esses conceitos, e sem eles nenhum produto passaria na validação.
 *
 * O que a Kolecta exige e o ERP não guarda (escala, personagem, linha, número)
 * fica vazio de propósito. A validação vai apontar, produto a produto, e é
 * assim que o lojista descobre ANTES de importar, e não depois de 200 anúncios
 * travados na análise.
 */
export function produtoParaLinha(
  detalhe: any,
  escolhas: { categoria: string; condicao: string },
): Record<string, string> {
  const dim = dimensoesEmCm(detalhe);
  const peso = pesoEmGramas(detalhe);
  const preco = numeroPositivo(detalhe?.preco);

  return {
    title: String(detalhe?.nome ?? '').trim(),
    category: escolhas.categoria,
    condition: escolhas.condicao,
    description: descricaoDoProduto(detalhe),
    price: preco === null ? '' : String(preco),
    images: fotosDoProduto(detalhe).join(','),
    brand: String(detalhe?.marca ?? '').trim(),
    scale: '',
    jogo: '',
    line: '',
    personagem: '',
    numero: '',
    tituloObra: '',
    weight_grams: peso === null ? '' : String(peso),
    width_cm: dim.largura === null ? '' : String(dim.largura),
    height_cm: dim.altura === null ? '' : String(dim.altura),
    length_cm: dim.comprimento === null ? '' : String(dim.comprimento),
    sku: String(detalhe?.codigo ?? '').trim(),
    year: '',
    edition: '',
    // Fora do modelo da planilha: o EAN. A esteira de KPV da Kolecta casa por
    // GTIN, então produto que vem com ele entra identificado de verdade, e não
    // só por semelhança de nome.
    gtin: String(detalhe?.gtin ?? '').trim(),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function textoOuNull(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  return s || null;
}

function numeroPositivo(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function linkValido(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}
