/**
 * Peneira de publicação — regras PURAS (sem Nest/DB), fonte única da verdade.
 * Usadas pelo `ListingsService` (gate ao publicar) e por scripts de auditoria
 * (varrer anúncios existentes). Ajuste os limites aqui.
 */

export const MIN_DESCRIPTION_LENGTH = 30;
export const MIN_IMAGES = 3;

/** Campos do anúncio necessários para checar a peneira. */
export interface ListingPublishFields {
  type?: string | null;
  description?: string | null;
  priceInCents?: number | null;
  images?: string | null;
  categoryId?: string | null;
  condition?: string | null;
  weightGrams?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  lengthCm?: number | null;
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
): string[] {
  const missing: string[] = [];

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

  if (countImages(listing.images) < MIN_IMAGES) {
    missing.push(`Pelo menos ${MIN_IMAGES} fotos`);
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

  return missing;
}
