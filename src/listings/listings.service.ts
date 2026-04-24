import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, desc, and, getTableColumns, like } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export type CreateListingDto = {
  title: string;
  description?: string;
  categoryId?: string;
  brand?: string;
  line?: string;
  scale?: string;
  year?: string;
  edition?: string;
  condition: string; // lacrado | novo | mint | usado
  type: 'direct' | 'auction';
  priceInCents?: number;
  images?: string; // JSON array stringificado
};

export type UpdateListingDto = Partial<Omit<CreateListingDto, 'type'>>;

export type ListingRecord = typeof schema.listings.$inferSelect & {
  sellerName?: string | null;
};

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  // ── Buscar por ID ────────────────────────────────────────────────────────

  async findById(id: string): Promise<ListingRecord> {
    const result = await this.db
      .select({
        ...getTableColumns(schema.listings),
        sellerName: schema.users.name,
      })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .where(eq(schema.listings.id, id))
      .limit(1);

    if (!result.length) {
      throw new NotFoundException(`Anúncio ${id} não encontrado.`);
    }

    return result[0];
  }

  // ── Listar anúncios públicos ativos ──────────────────────────────────────

  async findAll(limit = 20, offset = 0, q?: string): Promise<ListingRecord[]> {
    let query = this.db
      .select({
        ...getTableColumns(schema.listings),
        sellerName: schema.users.name,
      })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .where(eq(schema.listings.status, 'active'))
      .$dynamic();

    if (q) {
      query = query.where(
        and(
          eq(schema.listings.status, 'active'),
          like(schema.listings.title, `%${q}%`),
        ),
      );
    }

    return query
      .orderBy(desc(schema.listings.createdAt))
      .limit(limit)
      .offset(offset);
  }

  // ── Listar anúncios para Administração (filtra por status) ───────────────

  async findAllAdmin(
    status?: string,
    limit = 50,
    offset = 0,
  ): Promise<ListingRecord[]> {
    let query = this.db
      .select({
        ...getTableColumns(schema.listings),
        sellerName: schema.users.name,
      })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .$dynamic();

    if (status) {
      query = query.where(eq(schema.listings.status, status));
    }

    return query
      .orderBy(desc(schema.listings.createdAt))
      .limit(limit)
      .offset(offset);
  }

  // ── Listar anúncios do vendedor (todas as status) ────────────────────────

  async findBySeller(sellerId: string): Promise<ListingRecord[]> {
    return this.db
      .select({
        ...getTableColumns(schema.listings),
        sellerName: schema.users.name,
      })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .where(eq(schema.listings.sellerId, sellerId))
      .orderBy(desc(schema.listings.createdAt));
  }

  // ── Criar anúncio ────────────────────────────────────────────────────────

  async create(
    sellerId: string,
    dto: CreateListingDto,
  ): Promise<ListingRecord> {
    const id = crypto.randomUUID();

    await this.db.insert(schema.listings).values({
      id,
      sellerId,
      ...dto,
      status: 'draft',
    });

    this.logger.log(`[create] Anúncio criado: ${id} por sellerId: ${sellerId}`);

    return this.findById(id);
  }

  // ── Atualizar anúncio ────────────────────────────────────────────────────

  async update(
    id: string,
    sellerId: string,
    dto: UpdateListingDto,
  ): Promise<ListingRecord> {
    const listing = await this.findById(id);

    // Apenas o próprio vendedor pode editar
    if (listing.sellerId !== sellerId) {
      throw new ForbiddenException(
        'Você não tem permissão para editar este anúncio.',
      );
    }

    await this.db
      .update(schema.listings)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(schema.listings.id, id));

    this.logger.log(`[update] Anúncio atualizado: ${id}`);

    return this.findById(id);
  }

  // ── Deletar anúncio ──────────────────────────────────────────────────────

  async remove(id: string, sellerId: string): Promise<void> {
    const listing = await this.findById(id);

    // Apenas o próprio vendedor pode deletar
    if (listing.sellerId !== sellerId) {
      throw new ForbiddenException(
        'Você não tem permissão para remover este anúncio.',
      );
    }

    await this.db.delete(schema.listings).where(eq(schema.listings.id, id));

    this.logger.log(`[remove] Anúncio removido: ${id}`);
  }

  // ── Atualizar status (admin/sistema) ─────────────────────────────────────

  async updateStatus(id: string, status: string): Promise<ListingRecord> {
    await this.findById(id); // garante existência

    await this.db
      .update(schema.listings)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.listings.id, id));

    this.logger.log(`[updateStatus] Anúncio ${id} → status: ${status}`);

    return this.findById(id);
  }

  // ── Toggle pause (vendedor) ───────────────────────────────────────────────

  async togglePause(
    id: string,
    sellerId: string,
  ): Promise<ListingRecord> {
    const listing = await this.findById(id);

    if (listing.sellerId !== sellerId) {
      throw new ForbiddenException(
        'Você não tem permissão para alterar este anúncio.',
      );
    }

    const newStatus = listing.status === 'paused' ? 'active' : 'paused';

    await this.db
      .update(schema.listings)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(schema.listings.id, id));

    this.logger.log(`[togglePause] Anúncio ${id}: ${listing.status} → ${newStatus}`);

    return this.findById(id);
  }
}
