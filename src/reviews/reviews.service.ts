import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, and, desc } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { CreateReviewDto } from './dto/review.dto';

// Só é possível avaliar depois que a transação efetivamente terminou.
// Fluxo de pedido: pending → paid → shipped → delivered → completed
const REVIEWABLE_STATUSES = ['delivered', 'completed'];

@Injectable()
export class ReviewsService {
  constructor(
    @Inject(DATABASE_CONNECTION) private db: LibSQLDatabase<typeof schema>,
  ) {}

  // ── Criar avaliação (gated por transação concluída) ──────────────────────────

  async createReview(authorId: string, dto: CreateReviewDto) {
    // Não há ValidationPipe global no projeto — validamos o rating manualmente.
    if (!Number.isInteger(dto.rating) || dto.rating < 1 || dto.rating > 5) {
      throw new BadRequestException(
        'A nota deve ser um número inteiro entre 1 e 5.',
      );
    }

    const order = await this.db.query.orders.findFirst({
      where: eq(schema.orders.id, dto.orderId),
    });

    if (!order) {
      throw new NotFoundException('Pedido não encontrado');
    }

    if (order.buyerId !== authorId && order.sellerId !== authorId) {
      throw new ForbiddenException('Você não participou deste pedido.');
    }

    if (!REVIEWABLE_STATUSES.includes(order.status)) {
      throw new ForbiddenException(
        'Só é possível avaliar após a entrega do pedido ser concluída.',
      );
    }

    // O alvo da avaliação é a contraparte do autor no pedido.
    const targetId =
      order.buyerId === authorId ? order.sellerId : order.buyerId;

    // Uma avaliação por autor por pedido.
    const existing = await this.db.query.reviews.findFirst({
      where: and(
        eq(schema.reviews.orderId, dto.orderId),
        eq(schema.reviews.authorId, authorId),
      ),
    });

    if (existing) {
      throw new ConflictException('Você já avaliou este pedido.');
    }

    const [review] = await this.db
      .insert(schema.reviews)
      .values({
        orderId: dto.orderId,
        authorId,
        targetId,
        rating: dto.rating,
        comment: dto.comment ?? null,
      })
      .returning();

    return review;
  }

  // ── Avaliações recebidas pelo usuário (como alvo) ────────────────────────────

  async getReceived(userId: string) {
    return this.db
      .select({
        id: schema.reviews.id,
        orderId: schema.reviews.orderId,
        rating: schema.reviews.rating,
        comment: schema.reviews.comment,
        createdAt: schema.reviews.createdAt,
        author: {
          id: schema.users.id,
          name: schema.users.name,
        },
      })
      .from(schema.reviews)
      .innerJoin(schema.users, eq(schema.reviews.authorId, schema.users.id))
      .where(eq(schema.reviews.targetId, userId))
      .orderBy(desc(schema.reviews.createdAt));
  }

  // ── Avaliações feitas pelo usuário (como autor) ──────────────────────────────

  async getGiven(userId: string) {
    return this.db
      .select({
        id: schema.reviews.id,
        orderId: schema.reviews.orderId,
        rating: schema.reviews.rating,
        comment: schema.reviews.comment,
        createdAt: schema.reviews.createdAt,
        target: {
          id: schema.users.id,
          name: schema.users.name,
        },
      })
      .from(schema.reviews)
      .innerJoin(schema.users, eq(schema.reviews.targetId, schema.users.id))
      .where(eq(schema.reviews.authorId, userId))
      .orderBy(desc(schema.reviews.createdAt));
  }
}
