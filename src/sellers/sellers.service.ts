import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import {
  users,
  sellerProfiles,
  listings,
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

    const data = await this.db
      .select()
      .from(listings)
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
