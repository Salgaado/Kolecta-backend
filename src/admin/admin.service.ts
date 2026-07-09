import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, count, sum, desc } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { UpdateUserRoleDto, ResolveDisputeDto } from './dto/admin.dto';
import { ListingsService } from '../listings/listings.service';

@Injectable()
export class AdminService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly listingsService: ListingsService,
  ) {}

  // ── GET /api/admin/stats ─────────────────────────────────────────────────

  async getStats() {
    const [[usersRow], [listingsRow], [ordersRow], [revenueRow], [disputesRow]] =
      await Promise.all([
        this.db.select({ total: count() }).from(schema.users),
        this.db.select({ total: count() }).from(schema.listings),
        this.db.select({ total: count() }).from(schema.orders),
        this.db
          .select({ total: sum(schema.orders.platformFeeInCents) })
          .from(schema.orders)
          .where(eq(schema.orders.status, 'completed')),
        this.db
          .select({ total: count() })
          .from(schema.disputes)
          .where(eq(schema.disputes.status, 'open')),
      ]);

    return {
      totalUsers: usersRow?.total ?? 0,
      totalListings: listingsRow?.total ?? 0,
      totalOrders: ordersRow?.total ?? 0,
      totalRevenueInCents: Number(revenueRow?.total ?? 0),
      openDisputes: disputesRow?.total ?? 0,
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

  // ── GET /api/admin/listings ──────────────────────────────────────────────

  async listListings(status?: string, limit = 50, offset = 0) {
    const rows = await this.db
      .select()
      .from(schema.listings)
      .orderBy(desc(schema.listings.createdAt))
      .limit(limit)
      .offset(offset);

    if (status) {
      return rows.filter((l) => l.status === status);
    }
    return rows;
  }

  // ── PATCH /api/admin/listings/:id/status ────────────────────────────────

  async updateListingStatus(listingId: string, status: string) {
    // Delega ao ListingsService (fonte única): além de atualizar o status, ele
    // inicia o relógio do leilão quando um anúncio de leilão é ativado
    // (startAuctionClockIfPending). Fazer o update aqui direto pularia isso.
    return this.listingsService.updateStatus(listingId, status);
  }
}
