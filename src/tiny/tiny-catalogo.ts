// Tradução de produto do Tiny (Olist ERP) para linha de importação da Kolecta.
//
// Espelha `bling/bling-catalogo.ts` de propósito: a linha de saída é a MESMA da
// importação por planilha (ver listings/import-rules.ts), então o produto do
// Tiny passa exatamente pelas mesmas regras e o vendedor recebe exatamente as
// mesmas mensagens de erro, venha o anúncio de um CSV, do Bling ou do Tiny.
//
// PURO, sem Nest e sem banco, para caber em teste sem subir nada. A parte que
// fala HTTP fica no TinyService.
//
// Campos lidos do swagger da API v3 (erp.tiny.com.br/public-api/v3, conferido
// em 08/09/2026), NÃO de uma conta real ainda (0 conexões):
//   GET /produtos          -> itens[]: id, sku, descricao, precos, situacao
//   GET /produtos/{id}      -> + descricaoComplementar, gtin, marca{nome},
//                              dimensoes{largura,altura,comprimento,pesoLiquido,
//                              pesoBruto}, precos{preco}, anexos[]{url,externo},
//                              estoque{quantidade}
//
// ⚠️ UNIDADE (a cicatriz do Bling): o swagger do Tiny NÃO declara a unidade de
// `dimensoes` nem de `pesoBruto`. Assumimos cm + kg — o padrão do cadastro do
// Tiny e o mesmo que o Bling usa HOJE (lá o bug de tratar como metros cotou
// frete de caixa 100x maior; ver bling-catalogo.ts). Enquanto não houver uma
// conta real para medir, um TETO DE SANIDADE (abaixo) transforma medida absurda
// em vazio, para a pendência aparecer na conferência ANTES de cotar frete
// errado, em vez de inflar a caixa em silêncio. Confirmar na primeira loja Tiny.

/**
 * Tetos de sanidade para peso e dimensão de um colecionável.
 *
 * Não é o tamanho "certo": é o ABSURDO. Uma miniatura, um card ou uma action
 * figure não chega perto disto. Medida que estoura o teto quase sempre é erro
 * de unidade (a caixa lida como metros, o peso lido como gramas-vezes-mil) — o
 * mesmo tipo de engano que no Bling cotou frete de uma caixa cem vezes maior.
 * Estourou o teto -> vira vazio -> a validação exige o campo e o lojista corrige
 * na tela, que é onde o erro tem que aparecer.
 */
const MAX_DIMENSAO_CM = 250;
const MAX_PESO_GRAMAS = 60000; // 60 kg

/** O que a listagem barata do Tiny devolve, já normalizado para a tela. */
export interface ProdutoTiny {
  id: number;
  nome: string;
  sku: string | null;
  precoEmReais: number | null;
  estoque: number | null;
  imagem: string | null;
  ativo: boolean;
}

export function normalizarProduto(p: any): ProdutoTiny {
  return {
    id: Number(p?.id),
    // No Tiny o NOME do produto mora em `descricao` (a descrição longa é a
    // `descricaoComplementar`). Trocar os dois deixaria o card sem título.
    nome: String(p?.descricao ?? p?.nome ?? '').trim(),
    sku: textoOuNull(p?.sku ?? p?.codigo),
    precoEmReais: numeroPositivo(p?.precos?.preco ?? p?.preco),
    estoque: Number.isFinite(Number(p?.estoque?.quantidade))
      ? Number(p.estoque.quantidade)
      : null,
    imagem: primeiraFoto(p),
    // 'A' = ativo (o enum do Tiny é A/I/E). Produto inativo ou excluído no ERP
    // não deveria virar anúncio no ar.
    ativo: String(p?.situacao ?? 'A').toUpperCase() === 'A',
  };
}

/**
 * Todas as fotos do produto, sem repetir.
 *
 * No Tiny as imagens vêm em `anexos[]`, cada uma com `url` e `externo`. Ao
 * contrário do Bling, o detalhe já traz os anexos embutidos, então não há uma
 * segunda chamada. Mantemos a ORDEM (a primeira é a capa) e deduplicamos pela
 * URL sem query string.
 *
 * ⚠️ Se a URL do anexo for assinada e expirar (como a do Bling), ela serve para
 * CONTAR e para BAIXAR na hora da importação, nunca para guardar no anúncio:
 * quem importa copia o arquivo para o nosso R2 (MediaService.copiarDeUrl).
 */
export function fotosDoProduto(detalhe: any): string[] {
  const anexos = Array.isArray(detalhe?.anexos) ? detalhe.anexos : [];
  const brutas = [detalhe?.imagemURL, ...anexos.map((a: any) => a?.url)];
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

function primeiraFoto(p: any): string | null {
  const fotos = fotosDoProduto(p);
  return fotos[0] ?? linkValido(p?.imagemURL);
}

/**
 * Escala achada no título do produto. Igual ao Bling: o ERP não tem campo de
 * escala e o título quase sempre diz ("Miniatura - 1:64 - 2016 Camaro").
 */
const DENOMINADORES = [12, 18, 24, 32, 41, 43, 64];

export function escalaNoTitulo(titulo: string | null | undefined): string | null {
  const texto = String(titulo ?? '');
  const achado = texto.match(/\b1\s*[:/-]\s*(\d{1,3})\b/);
  if (!achado) return null;
  const n = Number(achado[1]);
  return DENOMINADORES.includes(n) ? `1:${n}` : null;
}

/**
 * Peso do pacote em gramas. Prefere o BRUTO (produto embalado, que é o que os
 * Correios pesam). O Tiny grava em quilos. Estoura o teto de sanidade -> null.
 */
export function pesoEmGramas(detalhe: any): number | null {
  const d = detalhe?.dimensoes ?? {};
  const kg = numeroPositivo(d?.pesoBruto) ?? numeroPositivo(d?.pesoLiquido);
  if (kg === null) return null;
  const g = Math.round(kg * 1000);
  // ⚠️ Ver o cabeçalho: medida absurda quase sempre é erro de unidade. Vira
  // null para a pendência aparecer na conferência, não no frete.
  return g > MAX_PESO_GRAMAS ? null : g;
}

/** Dimensões em cm. Estoura o teto de sanidade -> null (ver cabeçalho). */
export function dimensoesEmCm(detalhe: any): {
  largura: number | null;
  altura: number | null;
  comprimento: number | null;
} {
  const d = detalhe?.dimensoes ?? {};
  const conv = (v: unknown) => {
    const n = numeroPositivo(v);
    if (n === null) return null;
    const cm = Math.round(n);
    return cm > MAX_DIMENSAO_CM ? null : cm;
  };
  return {
    largura: conv(d?.largura),
    altura: conv(d?.altura),
    comprimento: conv(d?.comprimento),
  };
}

/**
 * Descrição do anúncio. Fica com a mais rica das duas (a mais longa depois de
 * limpas): `descricaoComplementar` costuma ser o texto completo e `descricao`
 * é o próprio nome. Os dois campos passam pela limpeza de HTML.
 */
export function descricaoDoProduto(detalhe: any): string {
  const curta = limparHtml(detalhe?.descricao);
  const complementar = limparHtml(detalhe?.descricaoComplementar);
  return complementar.length > curta.length ? complementar : curta;
}

function limparHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
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
    .replace(/&#\d+;/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Produto do Tiny na forma de linha da planilha de importação.
 *
 * `categoria` e `condicao` vêm de FORA, escolhidos pelo lojista na tela: o Tiny
 * não tem esses conceitos. O que a Kolecta exige e o ERP não guarda (escala,
 * personagem, linha) fica vazio, e a validação aponta produto a produto ANTES
 * de importar.
 */
export function produtoParaLinha(
  detalhe: any,
  escolhas: {
    categoria: string;
    condicao: string;
    atributos?: Record<string, string>;
  },
): Record<string, string> {
  const dim = dimensoesEmCm(detalhe);
  const peso = pesoEmGramas(detalhe);
  const preco = numeroPositivo(detalhe?.precos?.preco ?? detalhe?.preco);
  const nome = String(detalhe?.descricao ?? detalhe?.nome ?? '').trim();

  const linha: Record<string, string> = {
    title: nome,
    category: escolhas.categoria,
    condition: escolhas.condicao,
    description: descricaoDoProduto(detalhe),
    price: preco === null ? '' : String(preco),
    images: fotosDoProduto(detalhe).join(','),
    brand: String(detalhe?.marca?.nome ?? '').trim(),
    scale: escalaNoTitulo(nome) ?? '',
    jogo: '',
    line: '',
    personagem: '',
    numero: '',
    tituloObra: '',
    weight_grams: peso === null ? '' : String(peso),
    width_cm: dim.largura === null ? '' : String(dim.largura),
    height_cm: dim.altura === null ? '' : String(dim.altura),
    length_cm: dim.comprimento === null ? '' : String(dim.comprimento),
    sku: String(detalhe?.sku ?? '').trim(),
    year: '',
    edition: '',
    // A esteira de KPV casa por GTIN, então produto com EAN entra identificado
    // de verdade, não só por semelhança de nome.
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
