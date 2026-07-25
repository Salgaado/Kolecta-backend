import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ─── Helpers ────────────────────────────────────────────────────────────────

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
};

// ─── Users ──────────────────────────────────────────────────────────────────
// ID espelhado do Clerk (ex: user_2Ppx...)

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  // user | admin
  role: text('role').notNull().default('user'),
  // CPF do comprador (só dígitos), capturado no checkout — exigido pela Pagar.me
  // na transação PIX/cartão. Dado sensível (LGPD): não logar, mascarar na saída.
  cpf: text('cpf'),
  // ID do customer na Pagar.me (cus_...), criado ao salvar o 1º cartão. Reusado
  // para vincular cartões salvos (lance por cartão). NUNCA guarda o nº do cartão.
  pagarmeCustomerId: text('pagarme_customer_id'),
  // Telefone com DDD (só dígitos). A Pagar.me EXIGE ao menos um telefone no
  // customer para autorizar cartão — sem ele o lance é recusado. O checkout já
  // pedia o número, mas descartava depois de usar.
  phone: text('phone'),

  // ─── Consentimento legal (Termos + LGPD) ────────────────────────────────────
  // Aceite registrado no cadastro (modal T10). LGPD exige consentimento
  // demonstrável: guardamos a versão dos termos e QUANDO cada aceite ocorreu.
  // null = usuário anterior ao gate de consentimento.
  termsVersion: text('terms_version'),
  termsAcceptedAt: integer('terms_accepted_at', { mode: 'timestamp' }),
  lgpdAcceptedAt: integer('lgpd_accepted_at', { mode: 'timestamp' }),

  ...timestamps,
});

// ─── Seller Profiles ─────────────────────────────────────────────────────────
// Extensão do usuário quando ele se torna vendedor

export const sellerProfiles = sqliteTable('seller_profiles', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  bio: text('bio'),
  // ID da conta Stripe Connect do vendedor
  stripeAccountId: text('stripe_account_id'),
  // Status do onboarding: not_started | pending | complete
  stripeOnboardingStatus: text('stripe_onboarding_status').default('not_started'),
  // Flags vindas da API Stripe V2
  stripeChargesEnabled: integer('stripe_charges_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  stripePayoutsEnabled: integer('stripe_payouts_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  // false = aguardando verificação | true = verificado pela equipe
  isVerified: integer('is_verified', { mode: 'boolean' })
    .notNull()
    .default(false),

  // ─── Pagar.me / KYC (recebedor) ─────────────────────────────────────────────
  // Aditivo: convive com os campos Stripe acima até o cleanup da migração
  // (ver docs/PLAN-pagarme-migration.md). KYC obrigatório por BACEN 3.978/20.
  pagarmeRecipientId: text('pagarme_recipient_id'),
  // Tipo de pessoa: 'individual' (CPF) | 'company' (CNPJ)
  recipientType: text('recipient_type'),
  // CPF/CNPJ — só dígitos. Dado sensível: não logar, mascarar no admin.
  documentNumber: text('document_number'),
  // Nome/razão social usado no cadastro do recebedor
  legalName: text('legal_name'),
  // Status do recebedor na Pagar.me:
  // not_started|registration|affiliation|active|refused|suspended|blocked
  pagarmeRecipientStatus: text('pagarme_recipient_status').default('not_started'),
  // Derivados do status (active ⇒ pode receber/sacar)
  canReceive: integer('can_receive', { mode: 'boolean' }).notNull().default(false),
  canWithdraw: integer('can_withdraw', { mode: 'boolean' })
    .notNull()
    .default(false),
  kycUpdatedAt: integer('kyc_updated_at', { mode: 'timestamp' }),

  // ─── Programa Membro Fundador (pré-lançamento) ──────────────────────────────
  // Benefício de LOJISTA. Requisito: 5 anúncios enviados antes do lançamento
  // (25/07/2026). Ver docs/PLAN-programa-fundadores.md.
  // Numeração: 0 = Artminis | 1..50 = evento/convite | 51..100 = landing.
  // null = não é fundador. O número, uma vez atribuído, é PERMANENTE (nunca se perde).
  founderNumber: integer('founder_number'),
  // none    = não participa
  // pending = cadastrou mas ainda não tem 5 anúncios
  // active  = virou fundador (>= 5 anúncios): taxa 9% + créditos correndo
  // lapsed  = perdeu taxa/créditos por inatividade (mantém número e selo)
  founderStatus: text('founder_status').notNull().default('none'),
  // Momento em que atingiu 'active'. Base para os 6 meses da taxa de 9%.
  founderSince: integer('founder_since', { mode: 'timestamp' }),
  // Último instante em que o fundador tinha algum anúncio ativo — usado pelo
  // job de manutenção (regra dos 15 dias) para decidir active -> lapsed.
  founderLastActiveListingAt: integer('founder_last_active_listing_at', {
    mode: 'timestamp',
  }),

  // ─── Perfil público da loja (editável pelo vendedor) ────────────────────────
  storeName: text('store_name'),
  // Foto da loja. Upload próprio (R2, via /api/media/upload) ou a imagem do
  // Clerk copiada no primeiro acesso. null = cai nas iniciais no front.
  avatarUrl: text('avatar_url'),
  city: text('city'),
  state: text('state'),
  website: text('website'),
  // JSON array stringificado das categorias da loja: '["Capacetes","Jaquetas"]'
  categories: text('categories'),

  // ─── Políticas da loja ──────────────────────────────────────────────────────
  policyShipping: text('policy_shipping'),
  policyReturns: text('policy_returns'),
  policyPayment: text('policy_payment'),
  // Nullable de propósito: adicionar NOT NULL a uma tabela com linhas força o
  // drizzle-kit a recriar/truncar no SQLite. O código trata null como false.
  acceptOffers: integer('accept_offers', { mode: 'boolean' }).default(false),
  maxDiscountPercent: integer('max_discount_percent'),

  // ─── Preferências de notificação ────────────────────────────────────────────
  // JSON stringificado: { "newOrder": { "email": true, "push": true }, ... }
  notificationPrefs: text('notification_prefs'),

  ...timestamps,
}, (t) => ({
  // Backstop de concorrência: dois fundadores nunca podem ter o mesmo número.
  // NULLs são distintos no SQLite, então não-fundadores (founderNumber = null)
  // não colidem.
  uqFounderNumber: uniqueIndex('uq_seller_founder_number').on(t.founderNumber),
}));

// ─── Founder Invite Codes ────────────────────────────────────────────────────
// Códigos do evento presencial. Cada código reserva um número da faixa 1..50.
// Resgatar um código atribui aquele número ao usuário (fora da faixa da landing,
// que só usa 51+). Ver docs/PLAN-programa-fundadores.md (T3).

export const founderInviteCodes = sqliteTable('founder_invite_codes', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // Código legível impresso/entregue no evento (ex: KOLECTA-FND-014)
  code: text('code').notNull().unique(),
  // Número reservado da faixa presencial (1..50) — único por código
  founderNumber: integer('founder_number').notNull().unique(),
  // null enquanto não resgatado
  redeemedByUserId: text('redeemed_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  redeemedAt: integer('redeemed_at', { mode: 'timestamp' }),
  ...timestamps,
});

// ─── Founder Highlight Credits ───────────────────────────────────────────────
// Carteira de créditos de destaque do fundador. Ao virar 'active' recebe 5
// créditos (1 crédito = 1 anúncio em destaque por 7 dias), validade 6 meses.
// Não acumulam, não transferem. Consumo integra com o sistema de destaque
// (a definir se há backend próprio). Ver docs/PLAN-programa-fundadores.md (T5).

export const founderCredits = sqliteTable('founder_credits', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  creditsTotal: integer('credits_total').notNull().default(0),
  creditsUsed: integer('credits_used').notNull().default(0),
  // Créditos não usados expiram nesta data (founderSince + 6 meses)
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  ...timestamps,
});

// ─── Categories ──────────────────────────────────────────────────────────────
// Árvore de categorias (pode ter parentId para subcategorias)

export const categories = sqliteTable('categories', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  icon: text('icon'), // emoji ou nome de ícone
  parentId: text('parent_id'), // null = categoria raiz
  ...timestamps,
});

// ─── Listings ────────────────────────────────────────────────────────────────
// Anúncios de venda (direta ou leilão)

export const listings = sqliteTable('listings', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sellerId: text('seller_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  categoryId: text('category_id').references(() => categories.id),
  title: text('title').notNull(),
  description: text('description'),

  // Metadados específicos de colecionáveis
  brand: text('brand'), // Ex: Hot Wheels
  line: text('line'), // Ex: RLC
  scale: text('scale'), // Ex: 1:64
  year: text('year'),
  edition: text('edition'), // Ex: Limited 5000 pçs

  // Atributos específicos por categoria (jogo, raridade, número, personagem,
  // grading, articulado, editora, volume, edição especial…). JSON stringificado
  // de um objeto chave→valor. Cada categoria usa seu próprio conjunto de chaves;
  // por isso é um mapa flexível em vez de colunas fixas.
  attributes: text('attributes'), // JSON: '{"jogo":"Pokémon","raridade":"Rara"}'

  // lacrado | novo | mint | usado
  condition: text('condition').notNull(),

  // direct | auction
  type: text('type').notNull().default('direct'),

  // Preço em centavos (inteiro) para evitar floating point
  priceInCents: integer('price_in_cents'),

  // URLs das fotos separadas por vírgula (simples para MVP, migra p/ tabela futura)
  images: text('images'), // JSON array stringificado: '["url1","url2"]'

  // Código interno de estoque do vendedor (pedido dos lojistas), para casar a
  // venda aqui com o controle que ele já usa. Nullable e SEM unicidade de
  // propósito: colecionador pessoa física não trabalha com SKU, e exigir
  // travaria a publicação dele. O mesmo código pode se repetir entre vendedores
  // diferentes — cada um só enxerga o próprio.
  sku: text('sku'),
  // Quantidade em estoque. O front já coleta (criação, edição e planilha) e o
  // backend descartava — o valor sumia e o estoque não aparecia em lugar
  // nenhum. null = não informado (o MVP vende 1 unidade por anúncio).
  stock: integer('stock'),

  // draft | pending_review | active | sold | cancelled | pending_payment
  status: text('status').notNull().default('draft'),

  // ── Moderação (admin) ──
  // Motivo da reprovação (quando status = 'rejected'/'cancelled' pela moderação):
  // o motivo escolhido pelo admin + observação livre, mostrado ao vendedor e no
  // e-mail de reprovação. Auditoria: quem moderou e quando (última mudança de
  // status pela moderação). Ver docs/pendencias-backend.md (2.1, 2.4).
  rejectionReason: text('rejection_reason'),
  moderatedBy: text('moderated_by').references(() => users.id),
  moderatedAt: integer('moderated_at', { mode: 'timestamp' }),

  // ── Dados de envio (frete) ──
  // Peso e dimensões do pacote, usados na cotação/etiqueta do Melhor Envio.
  // Nullable: quando ausentes, o ShippingService aplica defaults por ambiente
  // ou de colecionável. Peso em gramas (inteiro); dimensões em centímetros.
  weightGrams: integer('weight_grams'),
  widthCm: integer('width_cm'),
  heightCm: integer('height_cm'),
  lengthCm: integer('length_cm'),

  // ── Destaque (vitrine) ──
  // Anúncio em destaque até `featuredUntil` (null/passado = não destacado). Hoje
  // a única origem é o crédito de fundador (7 dias por crédito). `featuredSource`
  // rastreia a origem para futuros destaques pagos. Ver docs/PLAN-programa-fundadores.md (T5).
  featuredUntil: integer('featured_until', { mode: 'timestamp' }),
  // founder_credit | admin | (futuro: paid)
  featuredSource: text('featured_source'),

  ...timestamps,
});

// ─── Auctions ────────────────────────────────────────────────────────────────
// Configuração do leilão vinculado a um listing do tipo 'auction'

export const auctions = sqliteTable('auctions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  listingId: text('listing_id')
    .notNull()
    .references(() => listings.id, { onDelete: 'cascade' }),

  // Lance inicial e incremento mínimo em centavos
  startingBidInCents: integer('starting_bid_in_cents').notNull(),
  minIncrementInCents: integer('min_increment_in_cents')
    .notNull()
    .default(1000),
  currentBidInCents: integer('current_bid_in_cents'),
  reservePriceInCents: integer('reserve_price_in_cents'), // null = sem reserva

  // ID do usuário com o lance mais alto no momento
  currentWinnerId: text('current_winner_id').references(() => users.id),

  // Duração em horas e horário de término
  durationHours: integer('duration_hours').notNull().default(48),
  endsAt: integer('ends_at', { mode: 'timestamp' }),

  // ─── Pausa do leilão ────────────────────────────────────────────────────────
  // Leilão pausado continua `active` (segue aparecendo na vitrine e na aba de
  // lances), mas não recebe lance nem é encerrado pelo cron. Usado quando o
  // pagamento por cartão fica indisponível: o lance é garantido por cartão,
  // então deixar o relógio correndo encerraria leilões que ninguém pôde
  // disputar.
  // null = não pausado.
  pausedAt: integer('paused_at', { mode: 'timestamp' }),
  // Quanto tempo faltava no instante da pausa. Ao retomar, `endsAt` vira
  // `agora + isto` — o leilão volta com o tempo que tinha, não com o que
  // sobrou de um relógio que continuou correndo.
  pausedRemainingMs: integer('paused_remaining_ms'),

  // Anti-sniper: estende tempo se houver lance nos últimos minutos
  antiSniper: integer('anti_sniper', { mode: 'boolean' })
    .notNull()
    .default(true),

  // active | ended | cancelled
  status: text('status').notNull().default('active'),

  ...timestamps,
});

// ─── Bids ─────────────────────────────────────────────────────────────────────
// Histórico de lances em um leilão

export const bids = sqliteTable('bids', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  auctionId: text('auction_id')
    .notNull()
    .references(() => auctions.id, { onDelete: 'cascade' }),
  bidderId: text('bidder_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  amountInCents: integer('amount_in_cents').notNull(),
  // Ciclo do lance: active (líder, auth vigente) | outbid | won | lost | released
  status: text('status').notNull().default('active'),

  // ─── Pré-autorização no cartão (lance por cartão / retenção) ─────────────────
  // O lance líder tem uma pré-autorização (capture:false) na Pagar.me que garante
  // o valor. Ao ser superado → void (cancela a auth). No fechamento → captura.
  // O cron de re-auth cria uma nova auth antes de `authExpiresAt` e voida a antiga.
  pagarmeOrderId: text('pagarme_order_id'),
  pagarmeChargeId: text('pagarme_charge_id'),
  // Snapshot do card_id usado na auth (p/ re-autorizar no mesmo cartão).
  pagarmeCardId: text('pagarme_card_id'),
  // Validade estimada da pré-autorização (janela da adquirente ~5 dias).
  authExpiresAt: integer('auth_expires_at', { mode: 'timestamp' }),

  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Addresses ───────────────────────────────────────────────────────────────
// Endereços de entrega do comprador

export const addresses = sqliteTable('addresses', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  label: text('label'), // Ex: "Casa", "Trabalho"
  recipientName: text('recipient_name').notNull(),
  street: text('street').notNull(),
  number: text('number').notNull(),
  complement: text('complement'),
  neighborhood: text('neighborhood'),
  city: text('city').notNull(),
  state: text('state').notNull(), // UF: SP, RJ...
  zip: text('zip').notNull(),
  country: text('country').notNull().default('BR'),
  isDefault: integer('is_default', { mode: 'boolean' })
    .notNull()
    .default(false),
  ...timestamps,
});

// ─── Orders ──────────────────────────────────────────────────────────────────
// Pedidos criados após o checkout

export const orders = sqliteTable('orders', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  buyerId: text('buyer_id')
    .notNull()
    .references(() => users.id),
  sellerId: text('seller_id')
    .notNull()
    .references(() => users.id),
  listingId: text('listing_id')
    .notNull()
    .references(() => listings.id),
  addressId: text('address_id').references(() => addresses.id),

  // Valor total em centavos (item + frete)
  totalInCents: integer('total_in_cents').notNull(),

  // Frete cobrado do comprador, em centavos. Vai para a KOLECTA no split, junto
  // com a comissão: é ela que compra a etiqueta no Melhor Envio (o token é da
  // plataforma) e manda o PDF ao vendedor. A comissão continua incidindo só
  // sobre o item — o frete entra inteiro, sem percentual em cima.
  shippingInCents: integer('shipping_in_cents').default(0),

  // Método de entrega: 'shipping' (envio via transportadora) | 'pickup' (retirada
  // pessoal). Em 'pickup' NÃO há transporte, então a confirmação do comprador
  // libera o saldo NA HORA (sem a janela de 48h). Ver OrdersService.confirmDelivery.
  deliveryMethod: text('delivery_method').default('shipping'),

  // ID da sessão / payment intent do Stripe (legado — migrando p/ Pagar.me)
  stripePaymentId: text('stripe_payment_id'),

  // ── Pagar.me (split nativo — docs/PLAN-wallet-split.md, Fase 1) ──
  // Aditivo: convive com stripePaymentId até o cleanup (Fase 7).
  pagarmeOrderId: text('pagarme_order_id'),
  pagarmeChargeId: text('pagarme_charge_id'),

  // pending | pending_payment | paid | shipped | delivered | cancelled | refunded
  // pending_payment: arremate de leilão cuja captura da pré-auth falhou — o
  // vencedor tem até `paymentDeadlineAt` para pagar (Fase 4).
  status: text('status').notNull().default('pending'),

  // Prazo para o vencedor de um leilão pagar um pedido `pending_payment`. Depois
  // dele, o cron expira o pedido e oferece ao 2º colocado (ou reabre). Ver
  // AuctionsService.expireOverduePendingPayments (Fase 4).
  paymentDeadlineAt: integer('payment_deadline_at', { mode: 'timestamp' }),

  // Código de rastreamento do envio
  trackingCode: text('tracking_code'),

  // ── Etiqueta Melhor Envio (emissão automática) ──────────────────────────────
  // Serviço escolhido pelo comprador no checkout (PAC, SEDEX, Jadlog...). Sem
  // ele só sabemos QUANTO foi cobrado, não POR QUAL transportadora — e a
  // etiqueta sairia de um serviço diferente do que o comprador pagou.
  // null em leilão: não há checkout, então a emissão cota e pega a mais barata.
  shippingServiceId: integer('shipping_service_id'),
  shippingServiceName: text('shipping_service_name'),
  // ID do envio no carrinho do Melhor Envio. É a chave de idempotência da
  // emissão: com ele preenchido, NÃO se cria outro carrinho — cada checkout
  // debita dinheiro real da carteira da Kolecta.
  shippingCartId: text('shipping_cart_id'),
  // URL do PDF da etiqueta (retorno do /me/shipment/print).
  shippingLabelUrl: text('shipping_label_url'),
  // pending | cart | paid | generated | ready | failed
  // ready = PDF emitido E e-mail enviado ao remetente.
  shippingLabelStatus: text('shipping_label_status'),
  // Motivo da última falha, mostrado ao vendedor e ao admin. Saldo insuficiente
  // na carteira do Melhor Envio cai aqui — precisa ser visível, não silencioso.
  shippingLabelError: text('shipping_label_error'),
  shippingLabelAt: integer('shipping_label_at', { mode: 'timestamp' }),

  // ── Controle Financeiro ──
  // Valor líquido que o vendedor recebe (após taxas)
  sellerNetInCents: integer('seller_net_in_cents'),
  // Taxa da plataforma Kolecta em centavos
  platformFeeInCents: integer('platform_fee_in_cents'),
  // Taxa do Stripe em centavos (estimada) — legado
  stripeFeeInCents: integer('stripe_fee_in_cents'),
  // Taxa REAL do gateway (lida do charge da Pagar.me) — sucessora de stripeFeeInCents,
  // mata o GATEWAY_FEE_PERCENT hardcoded (bug B4). Preenchida na Fase 2.
  gatewayFeeInCents: integer('gateway_fee_in_cents'),

  // ── Controle de pagamento (para híbrido) ──
  walletAmountInCents: integer('wallet_amount_in_cents').default(0),
  externalAmountInCents: integer('external_amount_in_cents').default(0),
  // wallet | external | hybrid
  paymentMethod: text('payment_method'),
  // Instrumento externo usado na parte cobrada: 'pix' | 'credit_card'.
  // null quando o pedido foi pago 100% com saldo da wallet.
  paymentInstrument: text('payment_instrument'),
  // Nº de parcelas no cartão (1 = à vista). null para PIX/wallet.
  installments: integer('installments'),
  // Juros PAGO PELO COMPRADOR ao parcelar, em centavos. Custo do comprador —
  // NÃO é receita da plataforma: entra no recebedor da plataforma no split
  // apenas para compensar o custo de antecipação cobrado pela Pagar.me.
  interestInCents: integer('interest_in_cents').default(0),

  // ── Controle de Entrega e Liberação ──
  // deliveredAt = marcado pelo vendedor (legado); meDeliveredAt = status "entregue"
  // do rastreio Melhor Envio (fonte da verdade da retenção — Fase 4).
  deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
  meDeliveredAt: integer('me_delivered_at', { mode: 'timestamp' }),
  buyerConfirmedAt: integer('buyer_confirmed_at', { mode: 'timestamp' }),
  autoReleaseAt: integer('auto_release_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),

  ...timestamps,
});

// ─── Favorites ───────────────────────────────────────────────────────────────
// Anúncios salvos/favoritados por um usuário

export const favorites = sqliteTable('favorites', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  listingId: text('listing_id')
    .notNull()
    .references(() => listings.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Saved Cards ─────────────────────────────────────────────────────────────
// Cartão de crédito salvo no Financeiro, usado para dar LANCE por cartão
// (pré-autorização/retenção). PCI: guardamos apenas o card_id da Pagar.me
// (card_...) + metadados mascarados (brand/last4/holder/validade) — o número
// completo e o CVV NUNCA passam pelo nosso backend (tokenização no cliente).
// MVP: 1 cartão por usuário (uniqueIndex em userId).

export const savedCards = sqliteTable(
  'saved_cards',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // ID do cartão na Pagar.me (card_...), vinculado ao customer do usuário.
    pagarmeCardId: text('pagarme_card_id').notNull(),
    // Metadados mascarados para exibição (não são dados sensíveis PCI).
    brand: text('brand'),
    lastFour: text('last_four'),
    holderName: text('holder_name'),
    // MM/AAAA da validade (exibição).
    expMonth: integer('exp_month'),
    expYear: integer('exp_year'),
    ...timestamps,
  },
  (table) => ({
    // MVP: um cartão por usuário.
    userIdx: uniqueIndex('saved_cards_user_id_idx').on(table.userId),
  }),
);

// ─── Conversations ───────────────────────────────────────────────────────────
// Agrupamento de mensagens por negociação (comprador + vendedor + anúncio)

export const conversations = sqliteTable('conversations', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  listingId: text('listing_id')
    .notNull()
    .references(() => listings.id, { onDelete: 'cascade' }),
  buyerId: text('buyer_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  sellerId: text('seller_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  ...timestamps,
});

// ─── Messages ────────────────────────────────────────────────────────────────
// Mensagens dentro de uma conversa

export const messages = sqliteTable('messages', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  senderId: text('sender_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  readAt: integer('read_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Reviews ─────────────────────────────────────────────────────────────────
// Avaliações pós-transação (comprador avalia vendedor e vice-versa)

export const reviews = sqliteTable('reviews', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  authorId: text('author_id')
    .notNull()
    .references(() => users.id),
  targetId: text('target_id')
    .notNull()
    .references(() => users.id),
  // 1 a 5 estrelas
  rating: integer('rating').notNull(),
  comment: text('comment'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Disputes ────────────────────────────────────────────────────────────────
// Disputas abertas por compradores ou vendedores

export const disputes = sqliteTable('disputes', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  reporterId: text('reporter_id')
    .notNull()
    .references(() => users.id),
  reason: text('reason').notNull(),
  description: text('description'),
  // open | under_review | resolved | closed
  status: text('status').notNull().default('open'),
  // Resolução (quando status = resolved/closed): buyer_favor | seller_favor | no_resolution
  resolution: text('resolution'),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  ...timestamps,
});

// ─── Dispute Messages (timeline da disputa) ──────────────────────────────────
// Cada linha é um evento: mensagem de uma parte ou evento de sistema.
export const disputeMessages = sqliteTable('dispute_messages', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  disputeId: text('dispute_id')
    .notNull()
    .references(() => disputes.id, { onDelete: 'cascade' }),
  // null quando type = 'system'
  senderId: text('sender_id').references(() => users.id),
  // 'message' | 'system'
  type: text('type').notNull().default('message'),
  content: text('content').notNull(),
  ...timestamps,
});

// ─── Wallets ─────────────────────────────────────────────────────────────────
// Carteira interna de cada usuário/vendedor
export const wallets = sqliteTable('wallets', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  balanceInCents: integer('balance_in_cents').notNull().default(0),   // available_balance — saldo disponível
  pendingInCents: integer('pending_in_cents').notNull().default(0),   // held_balance — vendas retidas
  withdrawalPendingInCents: integer('withdrawal_pending_in_cents').notNull().default(0), // saques em processamento
  ...timestamps,
});

// ─── Wallet Transactions ─────────────────────────────────────────────────────
// Ledger atômico e append-only das operações financeiras na plataforma
export const walletTransactions = sqliteTable('wallet_transactions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  walletId: text('wallet_id')
    .notNull()
    .references(() => wallets.id, { onDelete: 'cascade' }),

  // credit = deposito manual ou venda efetivada
  // debit  = compra ou saque
  // hold   = dinheiro retido da venda enquanto o item não chega
  type: text('type').notNull(),

  amountInCents: integer('amount_in_cents').notNull(), // Sempre positivo; o tipo define o balanço
  status: text('status').notNull().default('completed'), // pending | completed | failed | reversed

  // Metadados
  orderId: text('order_id').references(() => orders.id),
  // Vínculo do hold de lance (type = bid_hold | bid_release) — Fase 6
  auctionId: text('auction_id').references(() => auctions.id),
  bidId: text('bid_id').references(() => bids.id),
  stripeEventId: text('stripe_event_id'),
  description: text('description'),

  ...timestamps,
});

// ─── Stripe Webhook Events ───────────────────────────────────────────────────
// Usado para garantir idempotência ao processar eventos
export const webhookEvents = sqliteTable('webhook_events', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  stripeEventId: text('stripe_event_id').notNull().unique(),
  // Idempotência genérica por provedor (Pagar.me e futuros). Hoje o webhook
  // Pagar.me ainda grava o id do evento em stripeEventId; migrar p/ cá na Fase 2.
  providerEventId: text('provider_event_id').unique(),
  type: text('type').notNull(), // ex: checkout.session.completed
  status: text('status').notNull().default('pending'), // pending | processed | failed
  errorMessage: text('error_message'),
  ...timestamps,
});

// ─── Withdrawal Requests ─────────────────────────────────────────────────────
// Solicitações de saque de sellers via Stripe Connect Express
export const withdrawalRequests = sqliteTable('withdrawal_requests', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Valor solicitado em centavos (mínimo: R$50,00 = 5000 centavos)
  amountInCents: integer('amount_in_cents').notNull(),

  // requested | processing | paid | failed | cancelled
  status: text('status').notNull().default('requested'),

  // IDs do Stripe para rastreabilidade (legado)
  stripePayoutId: text('stripe_payout_id'),
  stripeAccountId: text('stripe_account_id'),

  // Pagar.me — saque via /transfers (Fase 5)
  pagarmeTransferId: text('pagarme_transfer_id'),
  pagarmeRecipientId: text('pagarme_recipient_id'),

  // Motivo de falha (se status = failed)
  failureReason: text('failure_reason'),

  ...timestamps,
});

// ─── Bling Connections ───────────────────────────────────────────────────────
// Tokens OAuth v3 do Bling por seller — opcional e por conta
export const blingConnections = sqliteTable('bling_connections', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  // Unix timestamp em segundos de quando o access_token expira
  expiresAt: integer('expires_at').notNull(),
  ...timestamps,
});

// ─── Import Jobs ─────────────────────────────────────────────────────────────
// Jobs de importação em lote de anúncios via planilha (CSV/XLSX)
export const importJobs = sqliteTable('import_jobs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  // processing | completed | failed | completed_with_errors
  status: text('status').notNull().default('processing'),

  totalRows: integer('total_rows').notNull().default(0),
  processedRows: integer('processed_rows').notNull().default(0),
  failedRows: integer('failed_rows').notNull().default(0),

  // JSON stringificado contendo array de erros: [{"row": 2, "error": "Invalid price"}]
  errors: text('errors'),

  ...timestamps,
});

// ─── Community ───────────────────────────────────────────────────────────────
// Hub da comunidade: posts, interações e moderação. O ranking é materializado
// (coluna `score` recomputada por cron) e os contadores são denormalizados para
// leitura barata do feed.

export const communityPosts = sqliteTable('community_posts', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  authorId: text('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // collection | product | discussion | guide
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  // JSON array stringificado de URLs: '["url1","url2"]'
  images: text('images'),
  categoryId: text('category_id').references(() => categories.id),
  // Preenchido apenas em posts type=product (produto vinculado da plataforma)
  listingId: text('listing_id').references(() => listings.id),
  // active | hidden | removed
  status: text('status').notNull().default('active'),

  // Contadores denormalizados (mantidos pelas interações)
  likeCount: integer('like_count').notNull().default(0),
  saveCount: integer('save_count').notNull().default(0),
  commentCount: integer('comment_count').notNull().default(0),
  pinCount: integer('pin_count').notNull().default(0),

  // Ranking materializado pelo cron de relevância
  score: real('score').notNull().default(0),
  scoreUpdatedAt: integer('score_updated_at', { mode: 'timestamp' }),

  ...timestamps,
});

export const communityComments = sqliteTable('community_comments', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  postId: text('post_id')
    .notNull()
    .references(() => communityPosts.id, { onDelete: 'cascade' }),
  authorId: text('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  // active | hidden | removed
  status: text('status').notNull().default('active'),
  ...timestamps,
});

// Um like por (post, usuário) — idempotência garantida no banco
export const communityPostLikes = sqliteTable(
  'community_post_likes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    postId: text('post_id')
      .notNull()
      .references(() => communityPosts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({ uniq: uniqueIndex('uq_post_like').on(t.postId, t.userId) }),
);

// Um save por (post, usuário)
export const communityPostSaves = sqliteTable(
  'community_post_saves',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    postId: text('post_id')
      .notNull()
      .references(() => communityPosts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({ uniq: uniqueIndex('uq_post_save').on(t.postId, t.userId) }),
);

// Um pin por (post, usuário) — "merece aparecer mais"; peso maior no ranking
export const communityPins = sqliteTable(
  'community_pins',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    postId: text('post_id')
      .notNull()
      .references(() => communityPosts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({ uniq: uniqueIndex('uq_post_pin').on(t.postId, t.userId) }),
);

export const communityReports = sqliteTable('community_reports', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // post | comment
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  reporterId: text('reporter_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // spam | scam | fake_product | offensive | off_topic | external_ads | prohibited
  reason: text('reason').notNull(),
  description: text('description'),
  // open | reviewed | dismissed
  status: text('status').notNull().default('open'),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  ...timestamps,
});

// Usuário banido de postar/interagir na comunidade
export const communityBans = sqliteTable('community_bans', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  reason: text('reason'),
  bannedBy: text('banned_by')
    .notNull()
    .references(() => users.id),
  ...timestamps,
});

// ─── Email Log ───────────────────────────────────────────────────────────────
// Registro de e-mails transacionais enviados. Serve para:
//  1. Idempotência — não reenviar o mesmo e-mail se um webhook/evento duplicar
//     (chave lógica = template + refId + recipient).
//  2. Auditoria/observabilidade de entrega.
export const emailLog = sqliteTable(
  'email_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Slug do template (ex: 'order-confirmed', 'sale-made')
    template: text('template').notNull(),
    // Destinatário (e-mail)
    recipient: text('recipient').notNull(),
    // ID do recurso que originou o e-mail (ex: orderId) — para idempotência
    refId: text('ref_id'),
    // ID retornado pelo provedor (Resend) — para rastreio
    providerId: text('provider_id'),
    // sent | failed | skipped
    status: text('status').notNull().default('sent'),
    error: text('error'),
    ...timestamps,
  },
  (t) => ({
    // Evita reenvio do mesmo template para o mesmo ref/destinatário
    uniqByRef: uniqueIndex('email_log_template_ref_recipient_idx').on(
      t.template,
      t.refId,
      t.recipient,
    ),
  }),
);
