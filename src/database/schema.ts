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

  // lacrado | novo | mint | usado
  condition: text('condition').notNull(),

  // direct | auction
  type: text('type').notNull().default('direct'),

  // Preço em centavos (inteiro) para evitar floating point
  priceInCents: integer('price_in_cents'),

  // URLs das fotos separadas por vírgula (simples para MVP, migra p/ tabela futura)
  images: text('images'), // JSON array stringificado: '["url1","url2"]'

  // draft | pending_review | active | sold | cancelled
  status: text('status').notNull().default('draft'),

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

  // Valor total em centavos
  totalInCents: integer('total_in_cents').notNull(),

  // ID da sessão / payment intent do Stripe
  stripePaymentId: text('stripe_payment_id'),

  // pending | paid | shipped | delivered | cancelled | refunded
  status: text('status').notNull().default('pending'),

  // Código de rastreamento do envio
  trackingCode: text('tracking_code'),

  // ── Controle Financeiro ──
  // Valor líquido que o vendedor recebe (após taxas)
  sellerNetInCents: integer('seller_net_in_cents'),
  // Taxa da plataforma Kolecta em centavos
  platformFeeInCents: integer('platform_fee_in_cents'),
  // Taxa do Stripe em centavos (estimada)
  stripeFeeInCents: integer('stripe_fee_in_cents'),

  // ── Controle de pagamento (para híbrido) ──
  walletAmountInCents: integer('wallet_amount_in_cents').default(0),
  externalAmountInCents: integer('external_amount_in_cents').default(0),
  // wallet | external | hybrid
  paymentMethod: text('payment_method'),

  // ── Controle de Entrega e Liberação ──
  deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
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
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
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

  // IDs do Stripe para rastreabilidade
  stripePayoutId: text('stripe_payout_id'),
  stripeAccountId: text('stripe_account_id'),

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
