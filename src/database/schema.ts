import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

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
  // buyer | seller | admin
  role: text('role').notNull().default('buyer'),
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

// ─── Messages ────────────────────────────────────────────────────────────────
// Mensagens entre comprador e vendedor

export const messages = sqliteTable('messages', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  senderId: text('sender_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  receiverId: text('receiver_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Contexto opcional: mensagem vinculada a um anúncio ou pedido
  listingId: text('listing_id').references(() => listings.id),
  orderId: text('order_id').references(() => orders.id),
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
