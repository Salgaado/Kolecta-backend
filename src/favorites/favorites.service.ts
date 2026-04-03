import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

@Injectable()
export class FavoritesService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  async findAll(userId: string) {
    return this.db
      .select()
      .from(schema.favorites)
      .where(eq(schema.favorites.userId, userId));
  }

  async toggle(userId: string, listingId: string) {
    // Verifica se o listing existe
    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, listingId));

    if (!listing) throw new NotFoundException('Anúncio não encontrado');

    // Verifica se já é favorito
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
      // Toggle OFF — remove o favorito
      await this.db
        .delete(schema.favorites)
        .where(eq(schema.favorites.id, existing.id));
      return { favorited: false };
    }

    // Toggle ON — adiciona o favorito
    const [created] = await this.db
      .insert(schema.favorites)
      .values({ userId, listingId })
      .returning();

    return { favorited: true, data: created };
  }

  async remove(userId: string, listingId: string) {
    const [favorite] = await this.db
      .select()
      .from(schema.favorites)
      .where(
        and(
          eq(schema.favorites.userId, userId),
          eq(schema.favorites.listingId, listingId),
        ),
      );

    if (!favorite) throw new NotFoundException('Favorito não encontrado');

    await this.db
      .delete(schema.favorites)
      .where(eq(schema.favorites.id, favorite.id));
  }
}
