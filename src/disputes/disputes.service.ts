import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import {
  disputes,
  disputeMessages,
  orders,
  listings,
  users,
} from '../database/schema';

@Injectable()
export class DisputesService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: LibSQLDatabase<any>,
  ) {}

  private parseFirstImage(raw: string | null): string | null {
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr[0] ? arr[0] : null;
    } catch {
      return null;
    }
  }

  /** Lista as disputas abertas pelo usuário (comprador). */
  async findMine(userId: string) {
    const rows = await this.db
      .select({
        dispute: disputes,
        listingTitle: listings.title,
        listingImages: listings.images,
        sellerId: orders.sellerId,
        sellerName: users.name,
        totalInCents: orders.totalInCents,
      })
      .from(disputes)
      .innerJoin(orders, eq(disputes.orderId, orders.id))
      .leftJoin(listings, eq(orders.listingId, listings.id))
      .leftJoin(users, eq(orders.sellerId, users.id))
      .where(eq(disputes.reporterId, userId))
      .orderBy(desc(disputes.createdAt));

    return rows.map((r) => ({
      id: r.dispute.id,
      orderId: r.dispute.orderId,
      reason: r.dispute.reason,
      description: r.dispute.description,
      status: r.dispute.status,
      resolution: r.dispute.resolution,
      createdAt: r.dispute.createdAt,
      resolvedAt: r.dispute.resolvedAt,
      order: {
        id: r.dispute.orderId,
        listingTitle: r.listingTitle ?? 'Item indisponível',
        listingImage: this.parseFirstImage(r.listingImages ?? null),
        sellerId: r.sellerId,
        sellerName: r.sellerName ?? 'Vendedor',
        totalInCents: r.totalInCents ?? 0,
      },
    }));
  }

  /** Pedidos do comprador elegíveis para abrir disputa (pagos em diante, sem disputa aberta). */
  async eligibleOrders(userId: string) {
    const rows = await this.db
      .select({
        id: orders.id,
        status: orders.status,
        listingTitle: listings.title,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .leftJoin(listings, eq(orders.listingId, listings.id))
      .where(eq(orders.buyerId, userId))
      .orderBy(desc(orders.createdAt));

    const ELIGIBLE = ['paid', 'processing', 'shipped', 'delivered', 'disputed'];
    return rows
      .filter((o) => ELIGIBLE.includes(o.status))
      .map((o) => ({
        id: o.id,
        title: `Pedido #${o.id.slice(0, 8)} — ${o.listingTitle ?? 'Item'}`,
      }));
  }

  async create(
    userId: string,
    dto: { orderId: string; reason: string; description: string },
  ) {
    const order = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, dto.orderId))
      .get();

    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.buyerId !== userId)
      throw new ForbiddenException('Você não é o comprador deste pedido');

    // Uma disputa aberta por pedido.
    const existing = await this.db
      .select()
      .from(disputes)
      .where(eq(disputes.orderId, dto.orderId))
      .get();
    if (existing && ['open', 'under_review'].includes(existing.status)) {
      throw new BadRequestException('Já existe uma disputa aberta para este pedido');
    }

    const [created] = await this.db
      .insert(disputes)
      .values({
        orderId: dto.orderId,
        reporterId: userId,
        reason: dto.reason,
        description: dto.description,
        status: 'open',
      })
      .returning();

    // Marca o pedido como em disputa.
    await this.db
      .update(orders)
      .set({ status: 'disputed' })
      .where(eq(orders.id, dto.orderId))
      .run();

    // Eventos iniciais do timeline.
    await this.db.insert(disputeMessages).values([
      {
        disputeId: created.id,
        type: 'system',
        content: 'Disputa aberta pelo comprador',
      },
      {
        disputeId: created.id,
        senderId: userId,
        type: 'message',
        content: dto.description,
      },
    ]);

    return this.findOne(userId, created.id);
  }

  async findOne(userId: string, disputeId: string) {
    const row = await this.db
      .select({
        dispute: disputes,
        buyerId: orders.buyerId,
        sellerId: orders.sellerId,
        listingTitle: listings.title,
        listingImages: listings.images,
        sellerName: users.name,
        totalInCents: orders.totalInCents,
      })
      .from(disputes)
      .innerJoin(orders, eq(disputes.orderId, orders.id))
      .leftJoin(listings, eq(orders.listingId, listings.id))
      .leftJoin(users, eq(orders.sellerId, users.id))
      .where(eq(disputes.id, disputeId))
      .get();

    if (!row) throw new NotFoundException('Disputa não encontrada');

    // Só as partes do pedido (ou admin) enxergam.
    if (row.buyerId !== userId && row.sellerId !== userId) {
      throw new ForbiddenException('Acesso negado a esta disputa');
    }

    const msgs = await this.db
      .select({
        id: disputeMessages.id,
        senderId: disputeMessages.senderId,
        type: disputeMessages.type,
        content: disputeMessages.content,
        createdAt: disputeMessages.createdAt,
        senderName: users.name,
      })
      .from(disputeMessages)
      .leftJoin(users, eq(disputeMessages.senderId, users.id))
      .where(eq(disputeMessages.disputeId, disputeId))
      .orderBy(disputeMessages.createdAt);

    const timeline = msgs.map((m) => {
      let senderRole: 'buyer' | 'seller' | 'admin' | 'system' = 'system';
      if (m.type === 'message') {
        senderRole =
          m.senderId === row.buyerId
            ? 'buyer'
            : m.senderId === row.sellerId
              ? 'seller'
              : 'admin';
      }
      return {
        id: m.id,
        type: m.type,
        senderRole,
        senderName:
          m.type === 'system'
            ? null
            : senderRole === 'buyer'
              ? 'Você'
              : (m.senderName ?? 'Kolecta'),
        content: m.content,
        createdAt: m.createdAt,
      };
    });

    return {
      id: row.dispute.id,
      orderId: row.dispute.orderId,
      reason: row.dispute.reason,
      description: row.dispute.description,
      status: row.dispute.status,
      resolution: row.dispute.resolution,
      createdAt: row.dispute.createdAt,
      resolvedAt: row.dispute.resolvedAt,
      order: {
        id: row.dispute.orderId,
        listingTitle: row.listingTitle ?? 'Item indisponível',
        listingImage: this.parseFirstImage(row.listingImages ?? null),
        sellerId: row.sellerId,
        sellerName: row.sellerName ?? 'Vendedor',
        totalInCents: row.totalInCents ?? 0,
      },
      timeline,
    };
  }

  async addMessage(userId: string, disputeId: string, content: string) {
    const dispute = await this.db
      .select({ d: disputes, buyerId: orders.buyerId, sellerId: orders.sellerId })
      .from(disputes)
      .innerJoin(orders, eq(disputes.orderId, orders.id))
      .where(eq(disputes.id, disputeId))
      .get();

    if (!dispute) throw new NotFoundException('Disputa não encontrada');
    if (dispute.buyerId !== userId && dispute.sellerId !== userId) {
      throw new ForbiddenException('Acesso negado a esta disputa');
    }
    if (['resolved', 'closed'].includes(dispute.d.status)) {
      throw new BadRequestException('Esta disputa já foi encerrada');
    }

    await this.db.insert(disputeMessages).values({
      disputeId,
      senderId: userId,
      type: 'message',
      content,
    });

    return this.findOne(userId, disputeId);
  }
}
