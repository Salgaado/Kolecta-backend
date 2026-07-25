/**
 * Peneira de publicação — regras PURAS (sem Nest/DB), fonte única da verdade.
 * Usadas pelo `ListingsService` (gate ao publicar) e por scripts de auditoria
 * (varrer anúncios existentes). Ajuste os limites aqui.
 */

export const MIN_DESCRIPTION_LENGTH = 30;
export const MIN_TITLE_LENGTH = 10;
export const MIN_IMAGES = 3;
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
 */
export const CATEGORY_REQUIRED_FIELDS: Record<
  string,
  Array<{ key: string; label: string }>
> = {
  'miniaturas-diecast': [
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
  'mangas-hqs': [{ key: 'tituloObra', label: 'Título da obra' }],
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
    missing.push(`Pelo menos ${MIN_IMAGES} fotos`);
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
