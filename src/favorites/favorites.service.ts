import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, and, getTableColumns, desc } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

@Injectable()
export class FavoritesService {
  private readonly logger = new Logger(FavoritesService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  async findAll(userId: string) {
    return this.db
      .select({
        ...getTableColumns(schema.favorites),
        listing: {
          ...getTableColumns(schema.listings),
        },
      })
      .from(schema.favorites)
      .innerJoin(
        schema.listings,
        eq(schema.favorites.listingId, schema.listings.id),
      )
      .where(eq(schema.favorites.userId, userId))
      .orderBy(desc(schema.favorites.createdAt));
  }

  async toggle(userId: string, listingId: string) {
    // Verificar se o listing existe
    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, listingId));

    if (!listing) {
      throw new NotFoundException('Anúncio não encontrado');
    }

    // Verificar se já é favorito
    const [existing] = await this.db
      .select()
      .from(schema.favorites)
      .where(
        and(
          eq(schema.favorites.userId, userId),
          eq(schema.favorites.listingId, listingId),
        ),
      );

    if (existing) {
      await this.db
        .delete(schema.favorites)
        .where(
          and(
            eq(schema.favorites.userId, userId),
            eq(schema.favorites.listingId, listingId),
          ),
        );
      return { favorited: false };
    } else {
      const id = crypto.randomUUID();
      const [created] = await this.db
        .insert(schema.favorites)
        .values({
          id,
          userId,
          listingId,
        })
        .returning();
      return { favorited: true, data: created };
    }
  }

  async remove(userId: string, listingId: string) {
    const [existing] = await this.db
      .select()
      .from(schema.favorites)
      .where(
        and(
          eq(schema.favorites.userId, userId),
          eq(schema.favorites.listingId, listingId),
        ),
      );

    if (!existing) {
      throw new NotFoundException('Favorito não encontrado');
    }

    await this.db
      .delete(schema.favorites)
      .where(
        and(
          eq(schema.favorites.userId, userId),
          eq(schema.favorites.listingId, listingId),
        ),
      );
  }
}
