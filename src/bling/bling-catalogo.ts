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
    // `imagemURL` só existe na LISTAGEM, não no detalhe. Fica aqui porque quem
    // chama pode repassá-lo, e porque ignorá-lo custou caro: eu lia fotos só do
    // detalhe e o resultado era zero foto em produto que claramente tinha.
    detalhe?.imagemURL,
    ...(Array.isArray(detalhe?.midia?.imagens?.externas)
      ? detalhe.midia.imagens.externas.map((i: any) => i?.link)
      : []),
    // As INTERNAS são as fotos que o lojista subiu dentro do Bling, e nas duas
    // lojas conectadas em 06/08/2026 elas eram as ÚNICAS: `externas` vinha
    // vazio nos dois. Eu as descartava de propósito, achando que só havia
    // miniatura, e com isso zerava as fotos de todo mundo.
    //
    // Uso `link` (a imagem cheia, ~1 MB) e não `linkMiniatura` (3 KB).
    //
    // ATENÇÃO: esta URL é ASSINADA e expira em 7 dias. Ela serve para CONTAR e
    // para BAIXAR na hora da importação, nunca para guardar no anúncio. Quem
    // importa copia o arquivo para o nosso R2 (ver MediaService.copiarDeUrl).
    ...(Array.isArray(detalhe?.midia?.imagens?.internas)
      ? detalhe.midia.imagens.internas.map((i: any) => i?.link)
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
 * Escala achada no título do produto.
 *
 * O Bling não tem campo de escala, então até agora ela vinha do padrão do lote,
 * igual para todos. Isso quebra em catálogo misto: lojista com 1:64 e 1:18 no
 * mesmo lote ou importa em dois lotes ou marca tudo errado.
 *
 * O título quase sempre diz. Medido em 06/08/2026 nos 100 primeiros produtos de
 * cada loja conectada: 76% na Escala Miniaturas ("Miniatura - 1:64 - 2016
 * Camaro") e 2% na MF Minis, que usa outro padrão de nome. Onde não achar, o
 * padrão do lote continua valendo.
 *
 * Denominadores restritos à lista canônica de propósito: `1:5` num título não é
 * escala de miniatura, e aceitar qualquer número encheria o campo de lixo.
 */
const DENOMINADORES = [12, 18, 24, 32, 41, 43, 64];

export function escalaNoTitulo(titulo: string | null | undefined): string | null {
  const texto = String(titulo ?? '');
  // Aceita "1:64", "1/64", "1-64" e com espaço no meio, que aparecem no mundo real.
  const achado = texto.match(/\b1\s*[:/-]\s*(\d{1,3})\b/);
  if (!achado) return null;
  const n = Number(achado[1]);
  return DENOMINADORES.includes(n) ? `1:${n}` : null;
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
 * Os DOIS campos precisam passar pela limpeza. O antigo confiava que a
 * `descricaoCurta` já vinha limpa e só tratava a complementar, mas produto real
 * provou o contrário: o lojista cola a descrição do WORD na curta, e ela chega
 * cheia de `<p class="MsoNoSpacing">` e `<br />`. Sem limpar, o anúncio ia ao ar
 * com as tags à mostra.
 *
 * Fica com a mais rica das duas (a mais longa depois de limpas), porque uma
 * costuma ser o texto completo e a outra uma linha só ("Mini GT").
 */
export function descricaoDoProduto(detalhe: any): string {
  const curta = limparHtml(detalhe?.descricaoCurta);
  const complementar = limparHtml(detalhe?.descricaoComplementar);
  return complementar.length > curta.length ? complementar : curta;
}

function limparHtml(raw: unknown): string {
  return String(raw ?? '')
    // Comentários, inclusive os condicionais do Word (`<!--[if ...]> ... <![endif]-->`),
    // que carregam `>` no meio e enganariam o strip de tags abaixo.
    .replace(/<!--[\s\S]*?-->/g, '')
    // Bloco inteiro de <style>/<script> que o Word às vezes injeta: não é
    // conteúdo, é folha de estilo que viraria lixo se só tirássemos as tags.
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&(ndash|mdash);/gi, '-')
    .replace(/&#\d+;/g, '') // qualquer entidade numérica que sobrou
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n') // não deixa espaço grudado na quebra
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
  escolhas: {
    categoria: string;
    condicao: string;
    /**
     * Campos que a categoria exige e o ERP não guarda, escolhidos pelo lojista
     * para o lote inteiro. Escala é o caso que trava tudo: o Bling não tem esse
     * conceito, e sem ela NENHUM produto de miniaturas passa na validação.
     *
     * Funciona como preenchimento, não como sobrescrita: o que veio do produto
     * (marca, por exemplo) continua ganhando. Sobrescrever apagaria dado bom do
     * ERP em nome de uma escolha feita para o lote.
     */
    atributos?: Record<string, string>;
  },
): Record<string, string> {
  const dim = dimensoesEmCm(detalhe);
  const peso = pesoEmGramas(detalhe);
  const preco = numeroPositivo(detalhe?.preco);

  const linha: Record<string, string> = {
    title: String(detalhe?.nome ?? '').trim(),
    category: escolhas.categoria,
    condition: escolhas.condicao,
    description: descricaoDoProduto(detalhe),
    price: preco === null ? '' : String(preco),
    images: fotosDoProduto(detalhe).join(','),
    brand: String(detalhe?.marca ?? '').trim(),
    // Deduzida do título quando dá. O padrão do lote (mais abaixo) só preenche
    // o que ficou vazio, então catálogo misto sai com a escala certa em cada
    // produto em vez de tudo com a mesma.
    scale: escalaNoTitulo(detalhe?.nome) ?? '',
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
    //
    // Nas duas lojas conectadas em 06/08/2026 este campo veio VAZIO em todos os
    // produtos, então o ganho é real mas não é garantido.
    gtin: String(detalhe?.gtin ?? '').trim(),
  };

  // Preenche o que o ERP não tem, sem apagar o que ele tem.
  for (const [chave, valor] of Object.entries(escolhas.atributos ?? {})) {
    const texto = String(valor ?? '').trim();
    if (texto && !linha[chave]) linha[chave] = texto;
  }

  return linha;
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
