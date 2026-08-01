import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, sql, inArray, getTableColumns } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import {
  users,
  sellerProfiles,
  listings,
  auctions,
  orders,
  reviews,
} from '../database/schema';

@Injectable()
export class SellersService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: LibSQLDatabase<any>,
  ) {}

  async getSellerProfile(id: string) {
    const profile = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        bio: sellerProfiles.bio,
        avatarUrl: sellerProfiles.avatarUrl,
        isVerified: sellerProfiles.isVerified,
        createdAt: users.createdAt,
      })
      .from(users)
      .leftJoin(sellerProfiles, eq(users.id, sellerProfiles.userId))
      .where(eq(users.id, id))
      .get();

    if (!profile) {
      throw new NotFoundException('Vendedor não encontrado');
    }

    // Aggregations
    const activeListingsResult = await this.db
      .select({ count: sql<number>`cast(count(${listings.id}) as integer)` })
      .from(listings)
      .where(and(eq(listings.sellerId, id), eq(listings.status, 'active')))
      .get();

    const salesResult = await this.db
      .select({ count: sql<number>`cast(count(${orders.id}) as integer)` })
      .from(orders)
      .where(
        and(
          eq(orders.sellerId, id),
          inArray(orders.status, ['paid', 'shipped', 'delivered']),
        ),
      )
      .get();

    const reviewsResult = await this.db
      .select({
        count: sql<number>`cast(count(${reviews.id}) as integer)`,
        avgRating: sql<number>`cast(avg(${reviews.rating}) as real)`,
      })
      .from(reviews)
      .where(eq(reviews.targetId, id))
      .get();

    return {
      ...profile,
      totalActiveListings: activeListingsResult?.count || 0,
      totalSales: salesResult?.count || 0,
      totalReviews: reviewsResult?.count || 0,
      averageRating: reviewsResult?.avgRating
        ? Number(reviewsResult.avgRating.toFixed(1))
        : 0,
    };
  }

  // ─── Perfil autenticado do próprio vendedor (api/seller) ────────────────────

  /** Garante que exista uma linha de seller_profiles para o usuário. */
  private async ensureProfile(userId: string) {
    const existing = await this.db
      .select()
      .from(sellerProfiles)
      .where(eq(sellerProfiles.userId, userId))
      .get();
    if (existing) return existing;

    await this.db.insert(sellerProfiles).values({ userId }).run();
    return this.db
      .select()
      .from(sellerProfiles)
      .where(eq(sellerProfiles.userId, userId))
      .get();
  }

  private safeJsonArray(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /** GET /api/seller/profile — dados da loja + conta do vendedor logado. */
  async getMyProfile(userId: string) {
    const profile = await this.ensureProfile(userId);
    const user = await this.db
      .select({
        name: users.name,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .get();

    let notificationPrefs: Record<string, { email?: boolean; push?: boolean }> = {};
    if (profile?.notificationPrefs) {
      try {
        notificationPrefs = JSON.parse(profile.notificationPrefs);
      } catch {
        notificationPrefs = {};
      }
    }

    return {
      storeName: profile?.storeName ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      bio: profile?.bio ?? null,
      city: profile?.city ?? null,
      state: profile?.state ?? null,
      website: profile?.website ?? null,
      categories: this.safeJsonArray(profile?.categories ?? null),
      isVerified: profile?.isVerified ?? false,
      policies: {
        shipping: profile?.policyShipping ?? null,
        returns: profile?.policyReturns ?? null,
        payment: profile?.policyPayment ?? null,
        acceptOffers: profile?.acceptOffers ?? false,
        maxDiscountPercent: profile?.maxDiscountPercent ?? null,
      },
      notificationPrefs,
      account: {
        name: user?.name ?? null,
        email: user?.email ?? null,
        createdAt: user?.createdAt ?? null,
      },
    };
  }

  async updateMyProfile(
    userId: string,
    dto: {
      storeName?: string;
      avatarUrl?: string;
      bio?: string;
      city?: string;
      state?: string;
      website?: string;
      categories?: string[];
    },
  ) {
    await this.ensureProfile(userId);
    const patch: Record<string, unknown> = {};
    if (dto.storeName !== undefined) patch.storeName = dto.storeName;
    // String vazia = remover a foto (volta para as iniciais)
    if (dto.avatarUrl !== undefined) patch.avatarUrl = dto.avatarUrl || null;
    if (dto.bio !== undefined) patch.bio = dto.bio;
    if (dto.city !== undefined) patch.city = dto.city;
    if (dto.state !== undefined) patch.state = dto.state;
    if (dto.website !== undefined) patch.website = dto.website;
    if (dto.categories !== undefined)
      patch.categories = JSON.stringify(dto.categories);

    if (Object.keys(patch).length > 0) {
      await this.db
        .update(sellerProfiles)
        .set(patch)
        .where(eq(sellerProfiles.userId, userId))
        .run();
    }
    return this.getMyProfile(userId);
  }

  async updateMyPolicies(
    userId: string,
    dto: {
      shipping?: string;
      returns?: string;
      payment?: string;
      acceptOffers?: boolean;
      maxDiscountPercent?: number;
    },
  ) {
    await this.ensureProfile(userId);
    const patch: Record<string, unknown> = {};
    if (dto.shipping !== undefined) patch.policyShipping = dto.shipping;
    if (dto.returns !== undefined) patch.policyReturns = dto.returns;
    if (dto.payment !== undefined) patch.policyPayment = dto.payment;
    if (dto.acceptOffers !== undefined) patch.acceptOffers = dto.acceptOffers;
    if (dto.maxDiscountPercent !== undefined)
      patch.maxDiscountPercent = dto.maxDiscountPercent;

    if (Object.keys(patch).length > 0) {
      await this.db
        .update(sellerProfiles)
        .set(patch)
        .where(eq(sellerProfiles.userId, userId))
        .run();
    }
    return this.getMyProfile(userId);
  }

  async updateMyNotificationPrefs(
    userId: string,
    prefs: Record<string, { email?: boolean; push?: boolean }>,
  ) {
    await this.ensureProfile(userId);
    await this.db
      .update(sellerProfiles)
      .set({ notificationPrefs: JSON.stringify(prefs ?? {}) })
      .where(eq(sellerProfiles.userId, userId))
      .run();
    return this.getMyProfile(userId);
  }

  async getSellerListings(
    id: string,
    page: number = 1,
    limit: number = 10,
    categoryId?: string,
  ) {
    const offset = (page - 1) * limit;

    let whereClause = and(
      eq(listings.sellerId, id),
      eq(listings.status, 'active'),
    );
    if (categoryId) {
      whereClause = and(whereClause, eq(listings.categoryId, categoryId));
    }

    // Dados do leilão junto do anúncio, como faz `/api/listings`.
    //
    // Sem isto a vitrine da loja escondia TODO leilão, rodando ou não: o front
    // decide a visibilidade por `leilaoAberto()`, que sem `endsAt` trata o
    // anúncio como leilão nunca iniciado e o descarta. A loja do vendedor era a
    // única tela pública que não recebia estes campos — 110 anúncios de leilão
    // ativos sumiam da própria loja enquanto apareciam na home e na busca.
    //
    // `leftJoin` e não `innerJoin`: anúncio de venda direta não tem leilão e não
    // pode sumir. É 1:1 (nenhum anúncio tem dois leilões), então não duplica
    // linha nem estraga a paginação.
    const data = await this.db
      .select({
        ...getTableColumns(listings),
        auctionId: auctions.id,
        startingBidInCents: auctions.startingBidInCents,
        minIncrementInCents: auctions.minIncrementInCents,
        currentBidInCents: auctions.currentBidInCents,
        reservePriceInCents: auctions.reservePriceInCents,
        endsAt: auctions.endsAt,
        auctionStatus: auctions.status,
        // Distingue leilão pausado de leilão nunca iniciado: hoje os dois têm
        // `endsAt` na sentinela de 2099, e só este campo os separa.
        auctionPausedAt: auctions.pausedAt,
        // O card do leilão escreve "{bidsCount} lances" sem proteção — faltando
        // o campo ele imprime "undefined lances".
        bidsCount: sql<number>`(
          SELECT COUNT(*) FROM bids WHERE bids.auction_id = ${auctions.id}
        )`.as('bids_count'),
      })
      .from(listings)
      .leftJoin(auctions, eq(auctions.listingId, listings.id))
      .where(whereClause)
      .limit(limit)
      .offset(offset);

    const countResult = await this.db
      .select({ count: sql<number>`cast(count(${listings.id}) as integer)` })
      .from(listings)
      .where(whereClause)
      .get();

    const total = countResult?.count || 0;

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getSellerReviews(id: string, page: number = 1, limit: number = 10) {
    const offset = (page - 1) * limit;

    const data = await this.db
      .select({
        id: reviews.id,
        rating: reviews.rating,
        comment: reviews.comment,
        createdAt: reviews.createdAt,
        author: {
          id: users.id,
          name: users.name,
        },
      })
      .from(reviews)
      .innerJoin(users, eq(reviews.authorId, users.id))
      .where(eq(reviews.targetId, id))
      .limit(limit)
      .offset(offset);

    const countResult = await this.db
      .select({ count: sql<number>`cast(count(${reviews.id}) as integer)` })
      .from(reviews)
      .where(eq(reviews.targetId, id))
      .get();

    const total = countResult?.count || 0;

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
