/**
 * Peneira de publicação — regras PURAS (sem Nest/DB), fonte única da verdade.
 * Usadas pelo `ListingsService` (gate ao publicar) e por scripts de auditoria
 * (varrer anúncios existentes). Ajuste os limites aqui.
 */

export const MIN_DESCRIPTION_LENGTH = 30;
export const MIN_TITLE_LENGTH = 10;
/**
 * Mínimo de fotos para o anúncio poder ir ao ar.
 *
 * Era 2, espelhando o wizard. Baixou para 1 por causa da IMPORTAÇÃO EM MASSA:
 * o ERP do lojista guarda uma imagem principal por produto, e as extras só
 * existem se ele cadastrou links externos. Exigir 2 faria a maior parte de um
 * catálogo de centenas de itens ser recusada, e a importação perderia o
 * sentido, que é justamente poupar o trabalho manual.
 *
 * O wizard de criação continua pedindo 2 (`MIN_IMAGES_FORMULARIO`, espelhado no
 * front): quem cadastra um item de cada vez tem o produto na mão e tira a
 * segunda foto. A exceção é para quem traz o catálogo pronto de fora.
 *
 * A contrapartida, que é real e é decisão de produto: um anúncio com uma foto
 * só pode ficar publicado. Se isso incomodar na vitrine, é esta constante que
 * volta para 2.
 *
 * Histórico: front e backend já ficaram dessincronizados aqui (o front baixou
 * para 2 e o backend seguia em 3), e como a APROVAÇÃO do admin usa esta regra,
 * o anúncio com 2 fotos era recusado sem explicação. Mudar aqui muda tudo.
 */
export const MIN_IMAGES = 1;

/** O que o wizard de criação manual pede. Espelhado em `src/lib/photos.ts`. */
export const MIN_IMAGES_FORMULARIO = 2;
/**
 * Teto de fotos. O front já bloqueia no upload (wizard, edição e importação),
 * mas a trava no navegador não vale para quem chama a API direto — e um anúncio
 * com dezenas de fotos pesa na vitrine e no custo de armazenamento.
 */
export const MAX_IMAGES = 8;

/**
 * Campos obrigatórios por categoria (slug). Espelha `required: true` do front
 * (`src/lib/category-fields.ts`) — fonte única do backend. `brand/line/scale`
 * têm coluna própria no listing; os demais vivem no JSON `attributes`.
 *
 * O critério de o que entra aqui: **o campo que serve de PRATELEIRA da
 * categoria** (`subcategoria: true` no front) é obrigatório, porque é por ele
 * que o comprador navega na vitrine. Vazio, o anúncio cai em "Outros" e some da
 * navegação sem ninguém perceber, nem o vendedor nem a gente.
 *
 * Conferido contra a produção em 05/08/2026: tudo que esta lista exigia estava
 * 100% preenchido nos anúncios ativos, o que mostra que o portão funciona. O
 * problema estava no que ele NÃO exigia (ver 'acessorios' abaixo).
 */
export const CATEGORY_REQUIRED_FIELDS: Record<
  string,
  Array<{ key: string; label: string }>
> = {
  'miniaturas-diecast': [
    // `line` NÃO entra de propósito, embora o formulário pedisse. Não é a
    // prateleira (marca é), e 142 dos 829 anúncios ativos já vivem sem ela:
    // exigir agora travaria esses 142 na próxima edição sem o comprador ganhar
    // nada. O formulário foi alinhado a esta lista, e não o contrário.
    { key: 'brand', label: 'Fabricante da miniatura' },
    { key: 'scale', label: 'Escala' },
  ],
  'cards-colecionaveis': [{ key: 'jogo', label: 'Jogo / Universo' }],
  'action-figures': [
    { key: 'brand', label: 'Fabricante' },
    { key: 'line', label: 'Linha / Série' },
    { key: 'personagem', label: 'Personagem' },
  ],
  'funko-pop': [
    { key: 'numero', label: 'Número do Pop' },
    { key: 'line', label: 'Linha / Universo' },
  ],
  'mangas-hqs': [
    { key: 'tituloObra', label: 'Título da obra' },
    // Prateleira da categoria.
    { key: 'editora', label: 'Editora' },
  ],
  // A categoria inteira estava fora desta lista, então o portão nunca pediu
  // nada dela. `tipo` é a prateleira, e os 5 acessórios ativos estavam com ela
  // VAZIA: todos caíam em "Outros" e a navegação da categoria não existia na
  // prática. O formulário já exigia os dois campos; era só aqui que faltava.
  acessorios: [
    { key: 'tipo', label: 'Tipo de acessório' },
    { key: 'escalaCompativel', label: 'Escala compatível' },
  ],
};

/** Chaves com coluna própria no listing; o resto vem do JSON `attributes`. */
const COLUMN_KEYS = new Set(['brand', 'line', 'scale', 'year', 'edition']);

/** Campos do anúncio necessários para checar a peneira. */
export interface ListingPublishFields {
  type?: string | null;
  title?: string | null;
  description?: string | null;
  priceInCents?: number | null;
  images?: string | null;
  categoryId?: string | null;
  condition?: string | null;
  weightGrams?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  lengthCm?: number | null;
  // Metadados de categoria (colunas + JSON) p/ os campos obrigatórios.
  brand?: string | null;
  line?: string | null;
  scale?: string | null;
  attributes?: string | null;
}

/** Opções derivadas (não são colunas diretas do listing). */
export interface ListingPublishContext {
  startingBidInCents?: number | null;
  reservePriceInCents?: number | null;
  categorySlug?: string | null;
}

function parseAttributes(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

/** Um campo de categoria está preenchido? Coluna própria ou chave em attributes. */
function hasFieldValue(listing: ListingPublishFields, key: string): boolean {
  const raw = COLUMN_KEYS.has(key)
    ? (listing as Record<string, unknown>)[key]
    : parseAttributes(listing.attributes)[key];
  if (typeof raw === 'string') return raw.trim().length > 0;
  return raw != null && raw !== '';
}

/** Conta imagens de `images` (JSON array stringificado ou CSV legado). */
export function countImages(raw: string | null | undefined): number {
  if (!raw) return 0;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(Boolean).length : 0;
  } catch {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean).length;
  }
}

/**
 * Retorna a lista (legível) de requisitos que FALTAM para publicar. Vazio = ok.
 * Para leilão, o "preço" é o lance inicial (`startingBidInCents`).
 */
export function listingPublishBlockers(
  listing: ListingPublishFields,
  startingBidInCents?: number | null,
  ctx?: ListingPublishContext,
): string[] {
  const missing: string[] = [];

  if (!listing.title || listing.title.trim().length < MIN_TITLE_LENGTH) {
    missing.push(`Título com pelo menos ${MIN_TITLE_LENGTH} caracteres`);
  }

  if (
    !listing.description ||
    listing.description.trim().length < MIN_DESCRIPTION_LENGTH
  ) {
    missing.push(`Descrição com pelo menos ${MIN_DESCRIPTION_LENGTH} caracteres`);
  }

  const price =
    listing.type === 'auction'
      ? startingBidInCents ?? 0
      : listing.priceInCents ?? 0;
  if (!price || price <= 0) {
    missing.push(
      listing.type === 'auction'
        ? 'Lance inicial maior que zero'
        : 'Preço maior que zero',
    );
  }

  const imageCount = countImages(listing.images);
  if (imageCount < MIN_IMAGES) {
    missing.push(
      MIN_IMAGES === 1 ? 'Pelo menos 1 foto' : `Pelo menos ${MIN_IMAGES} fotos`,
    );
  } else if (imageCount > MAX_IMAGES) {
    missing.push(`No máximo ${MAX_IMAGES} fotos (o anúncio tem ${imageCount})`);
  }

  if (!listing.categoryId) missing.push('Categoria');
  if (!listing.condition || !listing.condition.trim()) {
    missing.push('Condição do item');
  }
  if (
    !listing.weightGrams ||
    listing.weightGrams <= 0 ||
    !listing.widthCm ||
    !listing.heightCm ||
    !listing.lengthCm
  ) {
    missing.push('Peso e dimensões do pacote (necessários para o frete)');
  }

  // Leilão: preço de reserva não pode ser menor que o lance inicial.
  if (
    listing.type === 'auction' &&
    ctx?.reservePriceInCents != null &&
    startingBidInCents != null &&
    ctx.reservePriceInCents < startingBidInCents
  ) {
    missing.push('Preço de reserva não pode ser menor que o lance inicial');
  }

  // Campos obrigatórios da categoria (só quando o slug é conhecido — o script de
  // auditoria não passa o slug e pula esta parte, sem falso positivo).
  const required = ctx?.categorySlug
    ? CATEGORY_REQUIRED_FIELDS[ctx.categorySlug]
    : undefined;
  if (required) {
    for (const field of required) {
      if (!hasFieldValue(listing, field.key)) missing.push(field.label);
    }
  }

  return missing;
}
