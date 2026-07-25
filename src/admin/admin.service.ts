import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, count, sum, desc, and, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import {
  UpdateUserRoleDto,
  ResolveDisputeDto,
  SendTestEmailDto,
} from './dto/admin.dto';
import { ListingsService } from '../listings/listings.service';
import { FounderService } from '../founder/founder.service';
import { MailService } from '../notifications/mail/mail.service';

@Injectable()
export class AdminService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly listingsService: ListingsService,
    private readonly founderService: FounderService,
    private readonly mailService: MailService,
  ) {}

  /** Alias da tabela `users` para o moderador (users já é usado p/ o vendedor). */
  private readonly moderatorAlias = alias(schema.users, 'moderator_user');

  // ── GET /api/admin/stats ─────────────────────────────────────────────────

  async getStats() {
    // Ordem importa para o spec: as três primeiras terminam em .from(), as
    // demais em .where(). Ver o comentário em admin.service.spec.ts.
    const [
      [usersRow],
      [listingsRow],
      [ordersRow],
      [activeListingsRow],
      [revenueRow],
      [disputesRow],
      [auctionsRow],
    ] = await Promise.all([
      this.db.select({ total: count() }).from(schema.users),
      this.db.select({ total: count() }).from(schema.listings),
      this.db.select({ total: count() }).from(schema.orders),
      // Anúncios NO AR. O total da tabela inclui 716 rascunhos que nunca foram
      // enviados, então o painel exibia "878 anúncios" com 136 na vitrine.
      this.db
        .select({ total: count() })
        .from(schema.listings)
        .where(eq(schema.listings.status, 'active')),
      this.db
        .select({ total: sum(schema.orders.platformFeeInCents) })
        .from(schema.orders)
        .where(eq(schema.orders.status, 'completed')),
      this.db
        .select({ total: count() })
        .from(schema.disputes)
        .where(eq(schema.disputes.status, 'open')),
      // Leilão no ar exige as DUAS pontas: a linha em `auctions` nasce 'active'
      // junto com o anúncio, mesmo que ele nunca saia do rascunho. Sem o join
      // o painel contava 72 leilões "ativos" com 3 realmente na vitrine — 64
      // deles presos em rascunho.
      this.db
        .select({ total: count() })
        .from(schema.auctions)
        .innerJoin(
          schema.listings,
          eq(schema.listings.id, schema.auctions.listingId),
        )
        .where(
          and(
            eq(schema.auctions.status, 'active'),
            eq(schema.listings.status, 'active'),
          ),
        ),
    ]);

    return {
      totalUsers: usersRow?.total ?? 0,
      // Mantido para quem quiser o volume bruto do banco; o painel usa o de baixo.
      totalListings: listingsRow?.total ?? 0,
      activeListings: activeListingsRow?.total ?? 0,
      totalOrders: ordersRow?.total ?? 0,
      totalRevenueInCents: Number(revenueRow?.total ?? 0),
      openDisputes: disputesRow?.total ?? 0,
      activeAuctions: auctionsRow?.total ?? 0,
    };
  }

  // ── GET /api/admin/users ─────────────────────────────────────────────────

  async listUsers(limit = 50, offset = 0) {
    return this.db
      .select()
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt))
      .limit(limit)
      .offset(offset);
  }

  // ── PATCH /api/admin/users/:id/role ─────────────────────────────────────

  async updateUserRole(userId: string, dto: UpdateUserRoleDto) {
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    if (!user) throw new NotFoundException('Usuário não encontrado');

    const [updated] = await this.db
      .update(schema.users)
      .set({ role: dto.role, updatedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .returning();

    return updated;
  }

  // ── GET /api/admin/sellers ───────────────────────────────────────────────

  async listSellers(verified?: boolean) {
    const rows = await this.db
      .select()
      .from(schema.sellerProfiles)
      .orderBy(desc(schema.sellerProfiles.createdAt));

    if (verified !== undefined) {
      return rows.filter((s) => s.isVerified === verified);
    }
    return rows;
  }

  // ── PATCH /api/admin/sellers/:id/verify ─────────────────────────────────

  async verifySeller(sellerProfileId: string, verified: boolean) {
    const [profile] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.id, sellerProfileId));

    if (!profile) throw new NotFoundException('Perfil de vendedor não encontrado');

    const [updated] = await this.db
      .update(schema.sellerProfiles)
      .set({ isVerified: verified, updatedAt: new Date() })
      .where(eq(schema.sellerProfiles.id, sellerProfileId))
      .returning();

    return updated;
  }

  // ── GET /api/admin/disputes ──────────────────────────────────────────────

  async listDisputes(status?: string) {
    const rows = await this.db
      .select()
      .from(schema.disputes)
      .orderBy(desc(schema.disputes.createdAt));

    if (status) {
      return rows.filter((d) => d.status === status);
    }
    return rows;
  }

  // ── PATCH /api/admin/disputes/:id ───────────────────────────────────────

  async resolveDispute(disputeId: string, dto: ResolveDisputeDto) {
    const [dispute] = await this.db
      .select()
      .from(schema.disputes)
      .where(eq(schema.disputes.id, disputeId));

    if (!dispute) throw new NotFoundException('Disputa não encontrada');

    if (dispute.status === 'resolved' || dispute.status === 'closed') {
      throw new BadRequestException('Esta disputa já foi encerrada');
    }

    const [updated] = await this.db
      .update(schema.disputes)
      .set({
        status: dto.status,
        ...(dto.status === 'resolved' ? { resolvedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.disputes.id, disputeId))
      .returning();

    return updated;
  }

  // ── POST /api/admin/test-email ───────────────────────────────────────────

  /**
   * Dispara um e-mail real pelo MailService para validar a configuração do
   * ambiente (RESEND_API_KEY, remetente, domínio verificado) sem depender de
   * uma venda acontecer. Devolve o desfecho lido do `email_log`, então o admin
   * distingue os três casos sem acesso ao banco:
   *   sent    → provedor aceitou (vem o providerId do Resend)
   *   skipped → MailService desligado (falta MAIL_ENABLED=true / API key)
   *   failed  → provedor recusou (o motivo vem em `error`)
   */
  async sendTestEmail(dto: SendTestEmailDto) {
    const template = dto.template ?? 'kyc-approved';
    // refId único: a idempotência do MailService não deve pular reenvios de teste.
    const refId = `admin-test-${Date.now()}`;

    // Dados de amostra por template (nenhum toca dado real de pedido).
    const sample: Record<string, Record<string, unknown>> = {
      'kyc-approved': { name: 'Teste Kolecta' },
      'kyc-action-needed': { name: 'Teste Kolecta', status: 'refused' },
      'order-confirmed': {
        buyerName: 'Teste Kolecta',
        orderId: refId,
        listingTitle: 'Anúncio de teste',
        totalInCents: 12345,
      },
      'sale-made': {
        sellerName: 'Teste Kolecta',
        orderId: refId,
        listingTitle: 'Anúncio de teste',
        totalInCents: 12345,
      },
      welcome: { name: 'Teste Kolecta' },
      'listing-approved': {
        sellerName: 'Teste Kolecta',
        listingId: 'teste',
        listingTitle: 'Hot Wheels Porsche 917K — anúncio de teste',
      },
      'listing-rejected': {
        sellerName: 'Teste Kolecta',
        listingId: 'teste',
        listingTitle: 'Hot Wheels Porsche 917K — anúncio de teste',
        reason: 'As fotos estão desfocadas. Reenvie com 3 fotos nítidas.',
      },
      'order-shipped': {
        buyerName: 'Teste Kolecta',
        orderId: refId,
        listingTitle: 'Anúncio de teste',
        carrier: 'Correios',
        trackingCode: 'AA123456789BR',
      },
      'bid-received': {
        sellerName: 'Teste Kolecta',
        auctionId: 'teste',
        listingTitle: 'Shelby GT500 — leilão de teste',
        amountInCents: 15000,
        totalBids: 4,
      },
      'bid-outbid': {
        bidderName: 'Teste Kolecta',
        auctionId: 'teste',
        listingTitle: 'Shelby GT500 — leilão de teste',
        yourBidInCents: 12000,
        currentBidInCents: 15000,
        endsIn: '2 dias',
      },
      'auction-won': {
        winnerName: 'Teste Kolecta',
        orderId: refId,
        listingTitle: 'Shelby GT500 — leilão de teste',
        finalAmountInCents: 15000,
        needsPayment: true,
        paymentDeadlineHours: 48,
      },
      'message-received': {
        recipientName: 'Teste Kolecta',
        senderName: 'Comprador Teste',
        excerpt: 'Boa tarde! Esse item ainda está disponível?',
        listingTitle: 'Anúncio de teste',
      },
      'payout-released': {
        sellerName: 'Teste Kolecta',
        amountInCents: 24500,
        orderId: refId,
      },
      'dispute-opened': {
        sellerName: 'Teste Kolecta',
        orderId: refId,
        listingTitle: 'Anúncio de teste',
        reason: 'Item não corresponde à descrição',
        responseDeadlineDays: 3,
      },
    };

    await this.mailService.send({
      to: dto.to,
      template,
      data: sample[template],
      refId,
    });

    const [log] = await this.db
      .select()
      .from(schema.emailLog)
      .where(eq(schema.emailLog.refId, refId))
      .limit(1);

    return {
      to: dto.to,
      template,
      refId,
      status: log?.status ?? 'sem registro',
      providerId: log?.providerId ?? null,
      error: log?.error ?? null,
      hint:
        log?.status === 'skipped'
          ? 'MailService desligado: confira MAIL_ENABLED=true e RESEND_API_KEY no ambiente.'
          : log?.status === 'failed'
            ? 'O provedor recusou o envio — veja `error` (remetente/domínio costumam ser a causa).'
            : null,
    };
  }

  // ── GET /api/admin/listings ──────────────────────────────────────────────

  async listListings(status?: string, limit = 50, offset = 0) {
    // Junta a config do leilão (2.2): a fila de moderação precisa mostrar lance
    // inicial, incremento, reserva e duração para leilões antes de aprovar.
    const rows = await this.db
      .select({
        listing: schema.listings,
        sellerName: schema.users.name,
        moderatorName: this.moderatorAlias.name,
        auction: schema.auctions,
      })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .leftJoin(
        this.moderatorAlias,
        eq(schema.listings.moderatedBy, this.moderatorAlias.id),
      )
      .leftJoin(
        schema.auctions,
        eq(schema.auctions.listingId, schema.listings.id),
      )
      .where(status ? eq(schema.listings.status, status) : undefined)
      .orderBy(desc(schema.listings.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      // `...r.listing` já inclui rejectionReason/moderatedBy/moderatedAt (2.1/2.4).
      ...r.listing,
      sellerName: r.sellerName ?? null,
      // Auditoria de moderação (2.4): nome de quem moderou.
      moderatorName: r.moderatorName ?? null,
      // Config do leilão NO TOPO (2.2) — o front lê listing.startingBidInCents
      // etc. direto. Só quando type='auction'; venda direta não sobrepõe nada.
      ...(r.listing.type === 'auction' && r.auction
        ? {
            startingBidInCents: r.auction.startingBidInCents,
            minIncrementInCents: r.auction.minIncrementInCents,
            reservePriceInCents: r.auction.reservePriceInCents,
            durationHours: r.auction.durationHours,
            endsAt: r.auction.endsAt,
            antiSniper: r.auction.antiSniper,
          }
        : {}),
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Agregações (read-only) — dados reais para os dashboards do admin.
  // Status de pedido que representam uma venda efetiva.
  // ═══════════════════════════════════════════════════════════════════════════

  private static readonly SALE_STATUSES = [
    'paid',
    'processing',
    'shipped',
    'delivered',
    'completed',
  ];

  private static readonly MONTH_LABELS = [
    'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
    'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
  ];

  private monthBuckets(n: number) {
    const now = new Date();
    const buckets: { key: string; month: string }[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({
        key: `${d.getFullYear()}-${d.getMonth()}`,
        month: AdminService.MONTH_LABELS[d.getMonth()],
      });
    }
    return buckets;
  }

  private firstImage(raw: string | null): string | null {
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr[0] ? arr[0] : null;
    } catch {
      return null;
    }
  }

  // ── GET /api/admin/overview ──────────────────────────────────────────────
  async getOverview() {
    const [saleOrders, cats, sellersRows, pendingListings, unverified, openDisputes, activeAuctions] =
      await Promise.all([
        this.db
          .select({
            sellerId: schema.orders.sellerId,
            total: schema.orders.totalInCents,
            fee: schema.orders.platformFeeInCents,
            status: schema.orders.status,
            createdAt: schema.orders.createdAt,
            categoryId: schema.listings.categoryId,
            sellerName: schema.users.name,
          })
          .from(schema.orders)
          .leftJoin(schema.listings, eq(schema.orders.listingId, schema.listings.id))
          .leftJoin(schema.users, eq(schema.orders.sellerId, schema.users.id))
          .where(inArray(schema.orders.status, AdminService.SALE_STATUSES)),
        this.db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories),
        this.db
          .select({ userId: schema.sellerProfiles.userId, isVerified: schema.sellerProfiles.isVerified })
          .from(schema.sellerProfiles),
        this.db.select({ n: count() }).from(schema.listings).where(eq(schema.listings.status, 'pending_review')),
        this.db.select({ n: count() }).from(schema.sellerProfiles).where(eq(schema.sellerProfiles.isVerified, false)),
        this.db.select({ n: count() }).from(schema.disputes).where(eq(schema.disputes.status, 'open')),
        this.db.select({ n: count() }).from(schema.auctions).where(eq(schema.auctions.status, 'active')),
      ]);

    // Série mensal (6 meses): vendas (bruto) e comissão.
    const buckets = this.monthBuckets(6);
    const idx = new Map(buckets.map((b, i) => [b.key, i]));
    const salesByMonth = buckets.map((b) => ({ month: b.month, vendas: 0, comissao: 0 }));
    for (const o of saleOrders) {
      const d = new Date(o.createdAt as any);
      const i = idx.get(`${d.getFullYear()}-${d.getMonth()}`);
      if (i === undefined) continue;
      salesByMonth[i].vendas += (o.total ?? 0) / 100;
      salesByMonth[i].comissao += (o.fee ?? 0) / 100;
    }

    // Top vendedores por GMV.
    const bySeller = new Map<string, { name: string; sales: number; gmv: number }>();
    for (const o of saleOrders) {
      const cur = bySeller.get(o.sellerId) ?? { name: o.sellerName ?? 'Vendedor', sales: 0, gmv: 0 };
      cur.sales += 1;
      cur.gmv += (o.total ?? 0) / 100;
      bySeller.set(o.sellerId, cur);
    }
    const verifiedSet = new Set(sellersRows.filter((s) => s.isVerified).map((s) => s.userId));
    const topSellers = [...bySeller.entries()]
      .map(([sellerId, v]) => ({ sellerId, name: v.name, sales: v.sales, gmv: v.gmv, verified: verifiedSet.has(sellerId) }))
      .sort((a, b) => b.gmv - a.gmv)
      .slice(0, 5);

    // Distribuição por categoria (por GMV).
    const catName = new Map(cats.map((c) => [c.id, c.name]));
    const byCat = new Map<string, number>();
    for (const o of saleOrders) {
      const name = (o.categoryId && catName.get(o.categoryId)) || 'Outros';
      byCat.set(name, (byCat.get(name) ?? 0) + (o.total ?? 0) / 100);
    }
    const totalGmv = [...byCat.values()].reduce((a, b) => a + b, 0);
    const categoryBreakdown = [...byCat.entries()]
      .map(([name, gmv]) => ({ name, value: totalGmv > 0 ? Math.round((gmv / totalGmv) * 100) : 0 }))
      .sort((a, b) => b.value - a.value);

    return {
      salesByMonth,
      topSellers,
      categoryBreakdown,
      pendingActions: {
        pendingListings: pendingListings[0]?.n ?? 0,
        pendingVerifications: unverified[0]?.n ?? 0,
        openDisputes: openDisputes[0]?.n ?? 0,
      },
      activeAuctions: activeAuctions[0]?.n ?? 0,
    };
  }

  // ── GET /api/admin/reports ───────────────────────────────────────────────
  async getReports() {
    const [saleOrders, auctionsRows, bidsRows, cats] = await Promise.all([
      this.db
        .select({
          total: schema.orders.totalInCents,
          createdAt: schema.orders.createdAt,
          categoryId: schema.listings.categoryId,
        })
        .from(schema.orders)
        .leftJoin(schema.listings, eq(schema.orders.listingId, schema.listings.id))
        .where(inArray(schema.orders.status, AdminService.SALE_STATUSES)),
      this.db.select({ createdAt: schema.auctions.createdAt }).from(schema.auctions),
      this.db.select({ createdAt: schema.bids.createdAt }).from(schema.bids),
      this.db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories),
    ]);

    const buckets = this.monthBuckets(8);
    const idx = new Map(buckets.map((b, i) => [b.key, i]));
    const gmvByMonth = buckets.map((b) => ({ month: b.month, gmv: 0 }));
    const auctionMetrics = buckets.map((b) => ({ month: b.month, modoLance: 0, lances: 0 }));

    for (const o of saleOrders) {
      const d = new Date(o.createdAt as any);
      const i = idx.get(`${d.getFullYear()}-${d.getMonth()}`);
      if (i !== undefined) gmvByMonth[i].gmv += (o.total ?? 0) / 100;
    }
    for (const a of auctionsRows) {
      const d = new Date(a.createdAt as any);
      const i = idx.get(`${d.getFullYear()}-${d.getMonth()}`);
      if (i !== undefined) auctionMetrics[i].modoLance += 1;
    }
    for (const b of bidsRows) {
      const d = new Date(b.createdAt as any);
      const i = idx.get(`${d.getFullYear()}-${d.getMonth()}`);
      if (i !== undefined) auctionMetrics[i].lances += 1;
    }

    const catName = new Map(cats.map((c) => [c.id, c.name]));
    const byCat = new Map<string, { gmv: number; items: number }>();
    for (const o of saleOrders) {
      const name = (o.categoryId && catName.get(o.categoryId)) || 'Outros';
      const cur = byCat.get(name) ?? { gmv: 0, items: 0 };
      cur.gmv += (o.total ?? 0) / 100;
      cur.items += 1;
      byCat.set(name, cur);
    }
    const topCategories = [...byCat.entries()]
      .map(([name, v]) => ({ name, gmv: v.gmv, items: v.items }))
      .sort((a, b) => b.gmv - a.gmv);

    return { gmvByMonth, auctionMetrics, topCategories };
  }

  // ── GET /api/admin/financial ─────────────────────────────────────────────
  async getFinancial() {
    const [txRows, withdrawalsRows] = await Promise.all([
      this.db
        .select({
          id: schema.orders.id,
          createdAt: schema.orders.createdAt,
          total: schema.orders.totalInCents,
          fee: schema.orders.platformFeeInCents,
          net: schema.orders.sellerNetInCents,
          status: schema.orders.status,
          buyerName: schema.users.name,
        })
        .from(schema.orders)
        .leftJoin(schema.users, eq(schema.orders.buyerId, schema.users.id))
        .where(inArray(schema.orders.status, AdminService.SALE_STATUSES))
        .orderBy(desc(schema.orders.createdAt))
        .limit(100),
      this.db
        .select({
          id: schema.withdrawalRequests.id,
          userId: schema.withdrawalRequests.userId,
          amount: schema.withdrawalRequests.amountInCents,
          status: schema.withdrawalRequests.status,
          createdAt: schema.withdrawalRequests.createdAt,
          sellerName: schema.users.name,
        })
        .from(schema.withdrawalRequests)
        .leftJoin(schema.users, eq(schema.withdrawalRequests.userId, schema.users.id))
        .orderBy(desc(schema.withdrawalRequests.createdAt)),
    ]);

    // Sequência de nome do vendedor por pedido exige outra query; fazemos leve:
    const revenue = txRows
      .filter((t) => t.status === 'completed')
      .reduce((s, t) => s + (t.fee ?? 0) / 100, 0);
    const volume = txRows.reduce((s, t) => s + (t.total ?? 0) / 100, 0);
    const payouts = txRows
      .filter((t) => t.status === 'completed')
      .reduce((s, t) => s + (t.net ?? t.total ?? 0) / 100, 0);
    const pendingWithdrawalsTotal = withdrawalsRows
      .filter((w) => w.status === 'processing')
      .reduce((s, w) => s + (w.amount ?? 0) / 100, 0);

    const transactions = txRows.map((t) => {
      const gross = (t.total ?? 0) / 100;
      const commission = (t.fee ?? 0) / 100;
      return {
        id: t.id,
        orderId: `#${t.id.slice(0, 8)}`,
        date: t.createdAt,
        buyer: t.buyerName ?? 'Comprador',
        gross,
        commission,
        commissionPct: gross > 0 && t.fee != null ? Math.round((commission / gross) * 100) : null,
        net: t.net != null ? t.net / 100 : null,
        status: t.status,
      };
    });

    const pendingWithdrawals = withdrawalsRows
      .filter((w) => w.status === 'processing')
      .map((w) => ({
        id: w.id,
        date: w.createdAt,
        seller: w.sellerName ?? 'Vendedor',
        amount: (w.amount ?? 0) / 100,
      }));

    return {
      summary: { revenue, volume, payouts, pendingWithdrawals: pendingWithdrawalsTotal },
      transactions,
      pendingWithdrawals,
    };
  }

  // ── GET /api/admin/auctions ──────────────────────────────────────────────
  async getAuctionsMonitor() {
    const rows = await this.db
      .select({
        auction: schema.auctions,
        title: schema.listings.title,
        images: schema.listings.images,
        sellerId: schema.listings.sellerId,
        sellerName: schema.users.name,
      })
      .from(schema.auctions)
      .leftJoin(schema.listings, eq(schema.auctions.listingId, schema.listings.id))
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .orderBy(desc(schema.auctions.createdAt));

    // Contagem de lances por leilão.
    const bidCounts = await this.db
      .select({ auctionId: schema.bids.auctionId, n: count() })
      .from(schema.bids)
      .groupBy(schema.bids.auctionId);
    const bidMap = new Map(bidCounts.map((b) => [b.auctionId, Number(b.n)]));

    // Nome do vencedor.
    const winnerIds = rows.map((r) => r.auction.currentWinnerId).filter(Boolean) as string[];
    const winners = winnerIds.length
      ? await this.db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, winnerIds))
      : [];
    const winnerMap = new Map(winners.map((w) => [w.id, w.name]));

    return rows.map((r) => ({
      id: r.auction.id,
      listingId: r.auction.listingId,
      productName: r.title ?? 'Item',
      productImage: this.firstImage(r.images ?? null),
      sellerName: r.sellerName ?? 'Vendedor',
      currentBid: r.auction.currentBidInCents != null ? r.auction.currentBidInCents / 100 : null,
      startingBid: r.auction.startingBidInCents / 100,
      totalBids: bidMap.get(r.auction.id) ?? 0,
      startedAt: r.auction.createdAt,
      endsAt: r.auction.endsAt,
      status: r.auction.status, // active | ended | cancelled
      winnerName: r.auction.currentWinnerId ? (winnerMap.get(r.auction.currentWinnerId) ?? null) : null,
    }));
  }

  // ── GET /api/admin/sellers/detailed ──────────────────────────────────────
  // Vendedores com dados do usuário (nome/email/CPF) + contagem de pedidos.
  async listSellersDetailed() {
    const rows = await this.db
      .select({
        id: schema.sellerProfiles.id,
        userId: schema.sellerProfiles.userId,
        isVerified: schema.sellerProfiles.isVerified,
        documentNumber: schema.sellerProfiles.documentNumber,
        recipientStatus: schema.sellerProfiles.pagarmeRecipientStatus,
        createdAt: schema.sellerProfiles.createdAt,
        name: schema.users.name,
        email: schema.users.email,
      })
      .from(schema.sellerProfiles)
      .leftJoin(schema.users, eq(schema.sellerProfiles.userId, schema.users.id))
      .orderBy(desc(schema.sellerProfiles.createdAt));

    const orderCounts = await this.db
      .select({ sellerId: schema.orders.sellerId, n: count() })
      .from(schema.orders)
      .where(inArray(schema.orders.status, AdminService.SALE_STATUSES))
      .groupBy(schema.orders.sellerId);
    const orderMap = new Map(orderCounts.map((o) => [o.sellerId, Number(o.n)]));

    const maskCpf = (doc: string | null) => {
      if (!doc) return null;
      const d = doc.replace(/\D/g, '');
      if (d.length === 11) return `***.***.***-${d.slice(-2)}`;
      if (d.length === 14) return `**.***.***/****-${d.slice(-2)}`;
      return '***';
    };

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name ?? null,
      email: r.email ?? null,
      cpfCnpj: maskCpf(r.documentNumber),
      isVerified: r.isVerified,
      recipientStatus: r.recipientStatus ?? null,
      createdAt: r.createdAt,
      previousOrders: orderMap.get(r.userId) ?? 0,
    }));
  }

  // ── PATCH /api/admin/listings/:id/status ────────────────────────────────

  async updateListingStatus(
    listingId: string,
    status: string,
    opts?: { reason?: string | null; moderatorId?: string },
  ) {
    // Delega ao ListingsService (fonte única): além de atualizar o status, ele
    // inicia o relógio do leilão quando um anúncio de leilão é ativado
    // (startAuctionClockIfPending). Fazer o update aqui direto pularia isso.
    // Persiste também o motivo da reprovação e a auditoria (quem/quando).
    return this.listingsService.updateStatus(listingId, status, opts);
  }

  // ── Programa Fundador (concessão pela equipe) ────────────────────────────

  /** Fila de candidatos a fundador + próximo número livre (delegado). */
  async listFounderCandidates() {
    return this.founderService.listCandidates();
  }

  /** Concede o selo a um candidato com número escolhido pela equipe (delegado). */
  async grantFounder(userId: string, founderNumber: number) {
    return this.founderService.grantFounder(userId, founderNumber);
  }
}
