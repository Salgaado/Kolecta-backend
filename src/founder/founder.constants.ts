// ─── Programa Membro Fundador — números fechados ─────────────────────────────
// Fonte única das regras do programa. Ver docs/PLAN-programa-fundadores.md.

/** Anúncios enviados necessários para virar fundador. Decisão 15/07: 5. */
export const FOUNDER_QUALIFY_LISTINGS = 5;

/** Total de vagas públicas (0 = Artminis fica fora da contagem de 100). */
export const FOUNDER_TOTAL_SLOTS = 100;

/** Faixa de números atribuída via landing (qualificação por anúncios). */
export const LANDING_RANGE = { min: 51, max: 100 } as const;

/**
 * Faixa que a EQUIPE pode conceder pelo painel. Vai de 1 porque a numeração real
 * virou sequencial: as dez primeiras concessões (#001 a #010, sorteio de 25/07)
 * saíram direto no banco, e o endpoint — que só aceitava {0} ∪ [51,100] — barrava
 * o #011 com "Número deve ser 0 (a casa) ou estar entre 51 e 100". A equipe
 * ficava dependendo de INSERT manual para conceder o selo.
 *
 * Engole a faixa de convite (1..50): quem manda no número agora é a equipe, e o
 * índice único `uq_seller_founder_number` continua sendo o backstop contra dois
 * fundadores com o mesmo número — inclusive contra um código de evento resgatado.
 */
export const GRANT_RANGE = { min: 1, max: 100 } as const;

/**
 * O #0 é a CASA: a conta da marca-mãe, fundadora zero da Kolecta. Fica fora das
 * duas faixas (1–50 do evento, 51–100 da landing) e é concedido só pelo admin.
 * O front já oferece esse número; sem isto aqui, a concessão era recusada com
 * "Número deve estar entre 51 e 100".
 */
export const NUMERO_DA_CASA = 0;

/** Faixa reservada aos códigos de convite do evento presencial. */
export const INVITE_RANGE = { min: 1, max: 50 } as const;

/** Créditos de destaque concedidos ao virar 'active'. */
export const FOUNDER_HIGHLIGHT_CREDITS = 5;

/** Dias que 1 crédito mantém o anúncio em destaque. */
export const FOUNDER_HIGHLIGHT_DAYS = 7;

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
