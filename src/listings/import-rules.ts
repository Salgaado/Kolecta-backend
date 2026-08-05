/**
 * Regras da importação por planilha — PURAS (sem Nest/DB).
 *
 * Espelho do contrato do front (`src/lib/import-listing.ts`). O front confere a
 * planilha antes de subir, mas isso só protege quem usa a tela: quem chamar
 * `POST /api/listings/import` direto continuaria criando anúncio incompleto.
 * Por isso a mesma validação roda aqui.
 *
 * Se as colunas mudarem no front, mudam aqui também.
 */
import {
  CATEGORY_REQUIRED_FIELDS,
  MIN_TITLE_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MIN_IMAGES,
  MAX_IMAGES,
} from './listing-publish-rules';
import {
  normalizarMarca,
  normalizarEscala,
  normalizarLinha,
} from './normalizacao';

export { MIN_IMAGES, MAX_IMAGES };

/** Slugs de categoria aceitos (mesma lista do front). */
export const CATEGORY_SLUGS = Object.keys(CATEGORY_REQUIRED_FIELDS);

/** Vocabulário atual de condição. O antigo (`lacrado`, `mint`…) saiu de cena. */
export const CONDITION_VALUES = [
  'novo-lacrado',
  'novo-sem-caixa',
  'usado-conservado',
  'usado-com-marcas',
];

/** Chaves que vão para colunas próprias; o resto do metadado vira `attributes`. */
const COLUMN_KEYS = new Set(['brand', 'scale', 'line', 'year', 'edition']);

/** Metadados por categoria que vivem no JSON `attributes`. */
const ATTRIBUTE_KEYS = [
  'jogo',
  'personagem',
  'numero',
  'tituloObra',
  // Prateleira de mangás e os dois campos obrigatórios de acessórios. Sem eles
  // na planilha, apertar o portão de publicação tornaria essas duas categorias
  // impossíveis de importar.
  'editora',
  'tipo',
  'escalaCompativel',
];

export interface ImportRowError {
  linha: number;
  campo: string;
  mensagem: string;
}

/** Aceita "149.90", "149,90" e "R$ 149,90". Null quando não dá para ler. */
export function parsePrice(raw: string | undefined): number | null {
  const clean = String(raw ?? '').replace(/[R$\s]/gi, '').trim();
  if (!clean) return null;
  const norm = clean.includes(',')
    ? clean.replace(/\./g, '').replace(',', '.')
    : clean;
  const n = Number(norm);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Divide as URLs de foto e descarta o que não for link. */
export function parsePhotos(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/\S+$/i.test(s));
}

/** Inteiro positivo (peso/dimensão). Null quando inválido. */
function parsePositiveInt(raw: string | undefined): number | null {
  const n = Number(String(raw ?? '').replace(',', '.').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * O modelo gerado pelo front traz DUAS linhas de instrução abaixo do cabeçalho
 * (rótulos e ajuda). Sem descartá-las, cada importação criaria dois anúncios
 * de lixo — ou dois erros que o vendedor não entenderia.
 */
export function isInstructionRow(row: Record<string, string>): boolean {
  const t = String(row.title ?? '').trim();
  return t === '' || t === 'Título *' || t.startsWith('Mínimo ');
}

/** Erros de uma linha. Vazio = linha válida. `numeroLinha` é o que o vendedor vê. */
export function validateImportRow(
  row: Record<string, string>,
  numeroLinha: number,
): ImportRowError[] {
  const errors: ImportRowError[] = [];
  const add = (campo: string, mensagem: string) =>
    errors.push({ linha: numeroLinha, campo, mensagem });
  const val = (k: string) => String(row[k] ?? '').trim();

  const title = val('title');
  if (!title) add('title', 'Título vazio');
  else if (title.length < MIN_TITLE_LENGTH) {
    add('title', `Título muito curto (mínimo ${MIN_TITLE_LENGTH} caracteres)`);
  }

  const category = val('category');
  if (!category) add('category', 'Categoria vazia');
  else if (!CATEGORY_SLUGS.includes(category)) {
    add('category', `Categoria desconhecida. Use: ${CATEGORY_SLUGS.join(', ')}`);
  }

  const condition = val('condition');
  if (!condition) add('condition', 'Condição vazia');
  else if (!CONDITION_VALUES.includes(condition)) {
    add('condition', `Condição inválida. Use: ${CONDITION_VALUES.join(', ')}`);
  }

  const description = val('description');
  if (!description) add('description', 'Descrição vazia');
  else if (description.length < MIN_DESCRIPTION_LENGTH) {
    add(
      'description',
      `Descrição muito curta (mínimo ${MIN_DESCRIPTION_LENGTH} caracteres)`,
    );
  }

  if (parsePrice(val('price')) === null) {
    add('price', 'Preço inválido ou zerado. Ex: 149.90');
  }

  const photos = parsePhotos(val('images'));
  if (photos.length < MIN_IMAGES) {
    add(
      'images',
      `Envie de ${MIN_IMAGES} a ${MAX_IMAGES} URLs de foto (encontrei ${photos.length})`,
    );
  } else if (photos.length > MAX_IMAGES) {
    add('images', `Máximo de ${MAX_IMAGES} fotos (encontrei ${photos.length})`);
  }

  for (const [key, label] of [
    ['weight_grams', 'Peso'],
    ['width_cm', 'Largura'],
    ['height_cm', 'Altura'],
    ['length_cm', 'Comprimento'],
  ] as const) {
    if (parsePositiveInt(val(key)) === null) {
      add(key, `${label} inválido. Sem isso o frete sai errado.`);
    }
  }

  // Campos que a categoria exige. Só checa com categoria válida, senão vira ruído.
  const required = CATEGORY_REQUIRED_FIELDS[category];
  if (required) {
    for (const field of required) {
      if (!val(field.key)) {
        add(field.key, `${field.label} é obrigatório em ${category}`);
      }
    }
  }

  return errors;
}

export interface MappedImportRow {
  title: string;
  description: string;
  condition: string;
  categorySlug: string;
  priceInCents: number;
  images: string;
  weightGrams: number;
  widthCm: number;
  heightCm: number;
  lengthCm: number;
  brand: string | null;
  scale: string | null;
  line: string | null;
  year: string | null;
  edition: string | null;
  sku: string | null;
  /** Unidades à venda. A planilha do front sempre teve a coluna; o backend a ignorava. */
  stock: number;
  attributes: string | null;
}

/** Converte uma linha JÁ VALIDADA nos campos do anúncio. */
export function mapImportRow(row: Record<string, string>): MappedImportRow {
  const val = (k: string) => String(row[k] ?? '').trim();
  const opt = (k: string) => val(k) || null;

  // Metadados de categoria que não têm coluna própria vão para o JSON.
  const attrs: Record<string, string> = {};
  for (const key of ATTRIBUTE_KEYS) {
    if (!COLUMN_KEYS.has(key) && val(key)) attrs[key] = val(key);
  }

  return {
    title: val('title'),
    description: val('description'),
    condition: val('condition'),
    categorySlug: val('category'),
    priceInCents: Math.round(parsePrice(val('price'))! * 100),
    images: JSON.stringify(parsePhotos(val('images'))),
    weightGrams: parsePositiveInt(val('weight_grams'))!,
    widthCm: parsePositiveInt(val('width_cm'))!,
    heightCm: parsePositiveInt(val('height_cm'))!,
    lengthCm: parsePositiveInt(val('length_cm'))!,
    // Normalizados, e não crus. Os formulários de criação e edição já faziam
    // isso; a planilha era o caminho de escrita que passava por fora, e o banco
    // guarda o resultado: "COPAG", "Copag" e "Copag " viraram três prateleiras
    // para a mesma marca.
    brand: normalizarMarca(val('brand')),
    scale: normalizarEscala(val('scale')),
    line: normalizarLinha(val('line')),
    year: opt('year'),
    edition: opt('edition'),
    sku: opt('sku'),
    // A coluna existia no modelo gerado pelo front e o backend não lia: quem
    // preenchia estoque na planilha perdia o valor em silêncio. Vazio vira 1,
    // que é o padrão do formulário.
    stock: parsePositiveInt(val('stock')) ?? 1,
    attributes: Object.keys(attrs).length ? JSON.stringify(attrs) : null,
  };
}

/** Cabeçalho do CSV modelo, na mesma ordem do front. */
export const TEMPLATE_COLUMNS = [
  'title',
  'category',
  'condition',
  'description',
  'price',
  'images',
  'brand',
  'scale',
  'jogo',
  'line',
  'personagem',
  'numero',
  'tituloObra',
  'weight_grams',
  'width_cm',
  'height_cm',
  'length_cm',
  'sku',
  'stock',
  'year',
  'edition',
  'editora',
  'tipo',
  'escalaCompativel',
];
