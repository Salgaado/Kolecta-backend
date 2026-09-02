import {
  sqliteTable,
  text,
  integer,
  real,
  index,
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
  // Foto do usuário, copiada do Clerk no cadastro/login (a imagem já está
  // hospedada lá). É o fallback do avatar do vendedor quando ele não subiu foto
  // própria da loja em `seller_profiles.avatar_url` — sem isto o card mostrava
  // as iniciais mesmo para quem tinha foto.
  avatarUrl: text('avatar_url'),

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
  // URL amigável da loja (kolecta.com.br/<slug>), única. Gerada do store_name no
  // backfill/ao salvar; editar o handle vira perk de assinatura depois. Ver
  // docs/loja-personalizada e o ensure-seller-slug.ts.
  slug: text('slug').unique(),
  // Foto da loja. Upload próprio (R2, via /api/media/upload) ou a imagem do
  // Clerk copiada no primeiro acesso. null = cai nas iniciais no front.
  avatarUrl: text('avatar_url'),

  // ─── Capa da loja (banner) ──────────────────────────────────────────────────
  // Faixa no topo do perfil, no formato de LinkedIn/Twitter. Upload próprio no
  // R2 (via /api/media/upload), nunca URL de fora: capa apontando para servidor
  // do vendedor poderia trocar de imagem depois de aprovada e ainda medir quem
  // visita a loja. null = perfil como sempre foi (sem faixa).
  coverUrl: text('cover_url'),
  // Recorte vertical, 0 = topo, 100 = base. É o que impede a capa de cortar
  // justamente a cabeça do boneco. null = 50 (centro).
  coverFocalY: integer('cover_focal_y'),
  // Escurecimento sobre a imagem, em %. O nome da loja e o selo vivem em cima
  // da capa, e foto clara apagava os dois. O vendedor escolhe a IMAGEM, não
  // escolhe se dá para ler: o piso de 35 é validado no DTO e reaplicado no
  // front. null = 55.
  coverOverlay: integer('cover_overlay'),

  // ─── Redes sociais da loja ──────────────────────────────────────────────────
  // Ícones no topo do perfil, cada um independente: preencheu, aparece.
  //
  // Guardamos o IDENTIFICADOR, nunca a URL. O que está gravado aqui não é
  // `href` — a URL é montada na saída por `montarRedes()`, contra uma allowlist
  // de domínios. Sem isso, o campo "Instagram" seria um redirecionador aberto
  // numa página pública e indexável, com o ícone do Instagram do lado.
  //
  // null = não informado, e o ícone simplesmente não aparece.
  socialTiktok: text('social_tiktok'),
  socialInstagram: text('social_instagram'),
  // O YouTube guarda o CAMINHO do canal ('@nome', 'c/nome', 'channel/UC…'),
  // não só o handle: os três endereços coexistem e não são intercambiáveis.
  socialYoutube: text('social_youtube'),

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

  // ─── Preferências de envio ──────────────────────────────────────────────────
  // CSV de ids de serviço do Melhor Envio ('1,2,17'), no mesmo formato do
  // MELHOR_ENVIO_SERVICOS. Diz com quais transportadoras ESTE vendedor topa
  // trabalhar, porque a agência perto da casa dele é o que decide na prática.
  //
  // null = usa o conjunto da plataforma. É o estado de todo mundo hoje, e é por
  // isso que a coluna pode nascer sem backfill.
  //
  // A cotação cruza com o conjunto da plataforma (ver shipping/servicos.ts): a
  // escolha do vendedor RESTRINGE, nunca amplia.
  shippingServices: text('shipping_services'),

  // Aceita entregar em mãos? O comprador via "Retirada pessoal" no checkout de
  // TODO vendedor, inclusive o de outro estado, que depois tinha que explicar
  // que não dava. null = aceita, que é o comportamento de sempre e evita
  // backfill (o SQLite recria a tabela para adicionar NOT NULL).
  acceptsPickup: integer('accepts_pickup', { mode: 'boolean' }),

  // ─── Preferências de notificação ────────────────────────────────────────────
  // JSON stringificado: { "newOrder": { "email": true, "push": true }, ... }
  notificationPrefs: text('notification_prefs'),

  ...timestamps,
}, (t) => ({
  // Backstop de concorrência: dois fundadores nunca podem ter o mesmo número.
  // NULLs são distintos no SQLite, então não-fundadores (founderNumber = null)
  // não colidem.
  uqFounderNumber: uniqueIndex('uq_seller_founder_number').on(t.founderNumber),
  // Toda linha da vitrine junta o perfil do vendedor (nome da loja, foto, selo).
  userIdx: index('seller_profiles_user_idx').on(t.userId),
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

  // ID do produto no Bling do vendedor, quando o anúncio veio de lá.
  //
  // É o elo que faltava: sem ele não dá para saber que este anúncio e aquele
  // produto são a mesma coisa, então não haveria como reimportar sem duplicar
  // nem sincronizar estoque depois. null = anúncio criado na Kolecta.
  blingProductId: integer('bling_product_id'),
  // O mesmo elo, para quem usa Tiny (Olist ERP) em vez de Bling.
  //
  // Coluna nova em vez de um par genérico `(erp, erp_product_id)` de propósito:
  // trocar `bling_product_id` por um genérico é migração de dado em produção,
  // com anúncios reais já vinculados, para ganhar elegância. O preço desta
  // escolha é que a sincronização de estoque olha duas colunas — explícito, e
  // documentado em docs/PLAN-tiny-olist.md.
  //
  // Os dois nunca são preenchidos ao mesmo tempo: um anúncio nasce em UM ERP.
  tinyProductId: integer('tiny_product_id'),
  // Quantidade em estoque. O front já coleta (criação, edição e planilha) e o
  // backend descartava — o valor sumia e o estoque não aparecia em lugar
  // nenhum. null = não informado (o MVP vende 1 unidade por anúncio).
  stock: integer('stock'),
  // Este anúncio foi pausado por FALTA DE ESTOQUE, e não pela mão do vendedor.
  //
  // Sem essa distinção não dá para repor: `paused` sozinho não diz se o anúncio
  // saiu do ar porque zerou ou porque o vendedor tirou de propósito. Quem
  // sincroniza com o Bling precisa saber, senão o ERP republicaria justamente o
  // que ele decidiu esconder da vitrine.
  pausedByStock: integer('paused_by_stock', { mode: 'boolean' }).default(false),

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

  // ── Ordem na vitrine da loja ──
  // Posição escolhida pelo vendedor para os próprios anúncios na página dele
  // (arrastar para reordenar). Menor = mais acima. null = ainda não ordenado,
  // e cai para o fim na ordem padrão por data. Só afeta a vitrine da loja, não
  // a vitrine geral nem a busca.
  position: integer('position'),

  // ── Destaque da LOJA (escolha do vendedor) ──
  // Os poucos itens (no máximo 4) que o vendedor quer sempre no topo da página
  // dele, numa faixa própria acima da grade.
  //
  // Distinto de `featuredUntil` acima, que é destaque de PLATAFORMA (crédito de
  // fundador, vitrine geral) e expira. Misturar os dois faria o crédito do
  // fundador mexer na loja e o vendedor mexer na home. Este aqui não expira e
  // só afeta a loja do próprio vendedor.
  //
  // Guarda o INSTANTE em que foi fixado, e não um booleano, para responder
  // "destacado desde quando" sem uma tabela de histórico. null = não destacado.
  //
  // A ORDEM entre os destaques NÃO sai daqui: sai de `position`, a mesma que o
  // vendedor arrasta logo acima. O instante é gravado em segundos, então tudo
  // que for fixado na mesma chamada empataria e o desempate seria sorte —
  // enquanto `position` é escolha explícita dele e já tem tela.
  storePinnedAt: integer('store_pinned_at', { mode: 'timestamp' }),

  ...timestamps,
}, (t) => ({
  // A vitrine, a categoria e a busca saem todas de `GET /api/listings`, que
  // filtra por status e ordena por data. Sem índice, cada visita era uma
  // varredura da tabela inteira com ordenação em memória.
  statusCreatedIdx: index('listings_status_created_idx').on(
    t.status,
    t.createdAt,
  ),
  // Página de categoria: filtro por categoria dentro do que está no ar.
  statusCategoryIdx: index('listings_status_category_idx').on(
    t.status,
    t.categoryId,
  ),
  // Perfil da loja, "meus anúncios" e a contagem de qualificação do fundador.
  sellerIdx: index('listings_seller_idx').on(t.sellerId),
}));

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
}, (t) => ({
  // A vitrine junta leilão a cada anúncio para mostrar lance atual e relógio.
  listingIdx: index('auctions_listing_idx').on(t.listingId),
}));

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

  // ─── Pré-autorização no cartão (retenção que garante o lance) ───────────────
  // O líder da RETA FINAL tem uma pré-autorização (capture:false) na Pagar.me
  // que garante o valor; no arremate ela é capturada como pagamento da peça.
  //
  // NULO é estado normal, não erro: fora da reta final o lance não retém nada
  // (a garantia é armada quando cabe até o fecho — ver `armarRetencoesDeLideres`).
  // Ao ser superado → void. No arremate → captura.
  pagarmeOrderId: text('pagarme_order_id'),
  pagarmeChargeId: text('pagarme_charge_id'),
  // Snapshot do card_id usado na auth (p/ conferir/rearmar no mesmo cartão).
  pagarmeCardId: text('pagarme_card_id'),
  // Validade estimada da pré-autorização (janela da adquirente ~5 dias).
  authExpiresAt: integer('auth_expires_at', { mode: 'timestamp' }),

  // ─── Teto de autorizações por lance ─────────────────────────────────────────
  // O cartão de um comprador nunca pode ser tentado indefinidamente. Estas
  // colunas são o que impede: `holdAttempts` conta TODA tentativa de criar
  // retenção para este lance (bem ou mal sucedida) e para de vez ao bater o
  // teto. Sem elas o cron era um laço sem memória — foi assim que um lance de
  // R$45 virou 16 recusas seguidas no cartão de quem nem tinha arrematado.
  holdAttempts: integer('hold_attempts').notNull().default(0),
  holdLastError: text('hold_last_error'),
  /** Backoff: não tentar de novo antes disto. */
  holdNextAttemptAt: integer('hold_next_attempt_at', { mode: 'timestamp' }),
  /** Última vez que a retenção foi CONFERIDA na Pagar.me (limita as consultas). */
  holdCheckedAt: integer('hold_checked_at', { mode: 'timestamp' }),

  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (t) => ({
  // Contagem de lances no card da vitrine (subconsulta por anúncio de leilão)
  // e histórico da tela do leilão.
  auctionIdx: index('bids_auction_idx').on(t.auctionId),
}));

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

  // Quantidade de unidades do anúncio neste pedido. Default 1 (peça única e
  // pedidos antigos). Para item com estoque, o comprador pode levar N; o
  // total, o split e a baixa de estoque multiplicam por aqui.
  quantity: integer('quantity').notNull().default(1),

  // Valor total em centavos (item*quantidade + frete)
  totalInCents: integer('total_in_cents').notNull(),

  // Frete cobrado do comprador, em centavos. Vai para a KOLECTA no split, junto
  // com a comissão: é ela que compra a etiqueta no Melhor Envio (o token é da
  // plataforma) e manda o PDF ao vendedor. A comissão continua incidindo só
  // sobre o item — o frete entra inteiro, sem percentual em cima.
  shippingInCents: integer('shipping_in_cents').default(0),

  // ── Frete compartilhado (docs/PLAN-frete-compartilhado.md) ──────────────────
  // A Kolecta banca parte do frete: o comprador paga `F − S` e a plataforma
  // absorve `S`, tirado da própria comissão. As duas colunas abaixo existem
  // porque, sem elas, o custo real da etiqueta SOME do banco — `platform_fee`
  // passaria a guardar a comissão mais um frete já descontado, e a receita
  // ficaria superestimada em exatamente o subsídio. É o bug de 31/07 (painel
  // inflado em ~4×) de roupa nova. Ver `common/comissao.ts`.
  //
  // A invariante, e ela vale para todo pedido novo:
  //
  //     shipping_cost_in_cents = shipping_in_cents + shipping_subsidy_in_cents
  //
  // `shipping_in_cents` NÃO mudou de significado — continua sendo o frete
  // cobrado do comprador. É isso que mantém `platform_fee = comissão +
  // shipping_in_cents` correto nos seis pontos que calculam a taxa.
  //
  // Nulas em pedido anterior à política: `subsidy = null` ≡ 0 e `cost = null`
  // cai no `|| shippingInCents` de quem lê. Sem backfill.

  // O que a etiqueta custa de verdade — o que a Kolecta paga ao Melhor Envio.
  // É a referência do TETO_DE_ABSORCAO na troca de transportadora: ler o valor
  // subsidiado ali encolheria o teto e recusaria alternativas legítimas, com o
  // pedido já pago (shipping.service.ts).
  shippingCostInCents: integer('shipping_cost_in_cents'),
  // Quanto a Kolecta bancou. Sai da comissão dela; o vendedor não é afetado.
  shippingSubsidyInCents: integer('shipping_subsidy_in_cents'),

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

  // ── Rastreio do envio (Melhor Envio) ────────────────────────────────────────
  // Os marcos do /me/shipment/tracking, guardados para a tela ler rápido e para
  // o cron detectar a entrega sem repuxar o ME a cada acesso.
  // Status cru do Melhor Envio: posted | delivered | canceled...
  trackingStatus: text('tracking_status'),
  // Quando o objeto entrou na transportadora, e quando foi entregue.
  shippingPostedAt: integer('shipping_posted_at', { mode: 'timestamp' }),
  shippingDeliveredAt: integer('shipping_delivered_at', { mode: 'timestamp' }),
  // Última vez que consultamos o ME. O cron pula quem foi checado há pouco, para
  // respeitar o limite da API e não varrer o mesmo envio de minuto em minuto.
  trackingCheckedAt: integer('tracking_checked_at', { mode: 'timestamp' }),

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

  // Valor solicitado em centavos (mínimo: R$50,00 = 5000 centavos).
  // É o LÍQUIDO: o que cai na conta do vendedor. A taxa vem por cima.
  amountInCents: integer('amount_in_cents').notNull(),

  // Taxa de saque da Pagar.me (R$ 3,67 fixos), debitada da carteira JUNTO com
  // o valor. Guardada por linha para o histórico não mentir sobre o que saiu:
  // total debitado = amount_in_cents + fee_in_cents.
  // 0 nas linhas anteriores a 13/08/2026, quando a taxa não era cobrada aqui
  // (e por isso a carteira divergia do recebedor — ver docs/PLAN-taxa-de-saque.md).
  feeInCents: integer('fee_in_cents').notNull().default(0),

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

// ─── Tiny (Olist ERP) Connections ────────────────────────────────────────────
// Tokens OAuth v3 do Tiny por seller. Mesmo formato do Bling de propósito: o
// que muda entre os dois ERPs é o endereço e o formato do dado, não o que a
// gente guarda.
//
// NÃO tem `client_id`/`client_secret` aqui. Se a Olist confirmar que cada
// lojista gera as próprias credenciais (o "Caminho A" do PLAN-tiny-olist.md),
// elas entram em um segundo script, CRIPTOGRAFADAS — segredo de aplicativo de
// terceiro não expira sozinho como token, e não pode ficar em claro no banco.
export const tinyConnections = sqliteTable('tiny_connections', {
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
  // Anúncio mencionado no comentário, quando há um.
  //
  // Existe para dar ao vendedor um motivo legítimo de participar: mostrar a
  // peça dele sem mandar ninguém para fora. É o par da regra que bloqueia link
  // externo (ver community/link-externo.ts): tira o caminho de fora e abre o
  // de dentro.
  //
  // `set null` e não `cascade`: anúncio apagado não deve levar o comentário
  // junto, porque o texto continua fazendo sentido sem o card.
  listingId: text('listing_id').references(() => listings.id, {
    onDelete: 'set null',
  }),
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

// ─── Recipient Status History ────────────────────────────────────────────────
// Trilha append-only do que a Pagar.me respondeu sobre cada recebedor, e quando.
//
// `seller_profiles.pagarme_recipient_status` guarda só o estado ATUAL (é
// sobrescrito a cada webhook) e `webhook_events` guarda id e tipo do evento,
// sem payload. Sem esta tabela não sobra prova de que a Pagar.me devolveu
// `active` — só os logs da Render, que expiram.
//
// Virou necessário em 01/08: na conta nova o recebedor volta `active` na hora,
// **sem que o link de KYC seja emitido** (o endpoint responde 401). Se esses
// cadastros forem reavaliados depois e a prova de vida cobrada retroativamente,
// isto aqui é a evidência.
//
// `userId` NÃO referencia `users` de propósito: trilha de auditoria não pode
// ser apagada em cascata — é justamente quando alguém some que ela importa.
export const recipientStatusHistory = sqliteTable(
  'recipient_status_history',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull(),
    recipientId: text('recipient_id').notNull(),
    // registration | affiliation | active | refused | suspended | blocked
    status: text('status').notNull(),
    // 'onboard' = resposta do POST /recipients | 'webhook' = recipient.*
    source: text('source').notNull(),
    providerEventId: text('provider_event_id'),
    // O link de prova de vida chegou a ser emitido neste momento?
    kycLinkIssued: integer('kyc_link_issued', { mode: 'boolean' }),
    ...timestamps,
  },
  (t) => ({
    byRecipient: index('recipient_status_history_recipient_idx').on(
      t.recipientId,
      t.createdAt,
    ),
  }),
);

// ─── Analytics de trafego (funil proprio) ────────────────────────────────────
// Evento de comportamento do visitante, para o funil interno do painel: quantos
// viram, puseram no carrinho, iniciaram checkout, compraram, e quanto tempo
// ficaram. Sessao anonima gerada no cliente (sem cookie nem PII). NAO substitui
// o Google Analytics (que mede SEO/ads a parte); e o funil de conversao proprio.
export const analyticsEvents = sqliteTable(
  'analytics_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Sessao anonima do visitante (id gerado no cliente). Sem cookie nem PII.
    sessionId: text('session_id').notNull(),
    // Usuario logado, quando houver. null para visitante anonimo.
    userId: text('user_id'),
    // page_view | view_product | add_to_cart | checkout_start | purchase_complete | ...
    event: text('event').notNull(),
    path: text('path'),
    listingId: text('listing_id'),
    meta: text('meta'), // JSON stringificado
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    byCreated: index('analytics_events_created_idx').on(t.createdAt),
    bySessionEvent: index('analytics_events_session_event_idx').on(
      t.sessionId,
      t.event,
    ),
  }),
);
