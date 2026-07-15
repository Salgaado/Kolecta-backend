// ─── Programa Membro Fundador — números fechados ─────────────────────────────
// Fonte única das regras do programa. Ver docs/PLAN-programa-fundadores.md.

/** Anúncios enviados necessários para virar fundador. Decisão 15/07: 5. */
export const FOUNDER_QUALIFY_LISTINGS = 5;

/** Total de vagas públicas (0 = Artminis fica fora da contagem de 100). */
export const FOUNDER_TOTAL_SLOTS = 100;

/** Faixa de números atribuída via landing (qualificação por anúncios). */
export const LANDING_RANGE = { min: 51, max: 100 } as const;

/** Faixa reservada aos códigos de convite do evento presencial. */
export const INVITE_RANGE = { min: 1, max: 50 } as const;

/** Créditos de destaque concedidos ao virar 'active'. */
export const FOUNDER_HIGHLIGHT_CREDITS = 5;

/** Duração dos benefícios (taxa 9% + créditos) a partir de founderSince. */
export const FOUNDER_BENEFIT_MONTHS = 6;

/** Comissão reduzida do fundador ativo (%). */
export const FOUNDER_COMMISSION_PERCENT = 9;

/** Dias sem anúncio ativo que fazem o fundador cair para 'lapsed'. */
export const FOUNDER_LAPSE_DAYS = 15;

/** Status de anúncio que contam como "enviado" (fora de draft/cancelled). */
export const SUBMITTED_LISTING_STATUSES = [
  'pending_review',
  'active',
  'sold',
] as const;

/** Status de anúncio considerado "ativo" para a regra de manutenção. */
export const ACTIVE_LISTING_STATUS = 'active';
