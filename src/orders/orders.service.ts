import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WalletService } from '../wallet/wallet.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, inArray } from 'drizzle-orm';
import { CreateOrderDto, UpdateOrderStatusDto } from './dto/create-order.dto';
import { StripeService } from '../stripe/stripe.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly walletService: WalletService,
    private readonly stripeService: StripeService,
  ) {}

  // ── Create orders (legacy — sem PaymentIntent) ─────────────────────────────

  async createOrders(buyerId: string, dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('O carrinho está vazio');
    }

    const listingIds = dto.items.map((i) => i.listingId);

    const existingListings = await this.db
      .select()
      .from(schema.listings)
      .where(inArray(schema.listings.id, listingIds));

    if (existingListings.length !== listingIds.length) {
      throw new NotFoundException(
        'Um ou mais anúncios não foram encontrados no sistema',
      );
    }

    for (const listing of existingListings) {
      if (listing.status !== 'active') {
        throw new BadRequestException(
          `O anúncio ${listing.id} não está mais disponível para venda`,
        );
      }
      if (listing.sellerId === buyerId) {
        throw new ForbiddenException(
          `Você não pode comprar o seu próprio produto (${listing.id})`,
        );
      }
    }

    return await this.db.transaction(async (tx) => {
      const createdOrders = [];

      for (const listing of existingListings) {
        await tx
          .update(schema.listings)
          .set({ status: 'pending_payment' })
          .where(eq(schema.listings.id, listing.id));

        const [newOrder] = await tx
          .insert(schema.orders)
          .values({
            buyerId,
            sellerId: listing.sellerId,
            listingId: listing.id,
            totalInCents: listing.priceInCents ?? 0,
            status: 'pending',
          })
          .returning();

        createdOrders.push(newOrder);
      }

      return createdOrders;
    });
  }

  // ── Create order + PaymentIntent (checkout nativo) ─────────────────────────

  async createOrderWithPaymentIntent(buyerId: string, dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('O carrinho está vazio');
    }

    // Apenas 1 item por chamada no MVP (um PaymentIntent por vendedor)
    const listingId = dto.items[0].listingId;

    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, listingId));

    if (!listing) {
      throw new NotFoundException('Anúncio não encontrado');
    }
    if (listing.status !== 'active') {
      throw new BadRequestException('Este anúncio não está mais disponível para venda');
    }
    if (listing.sellerId === buyerId) {
      throw new ForbiddenException('Você não pode comprar o seu próprio produto');
    }

    // Transação atômica: bloqueia o listing + cria o pedido
    const order = await this.db.transaction(async (tx) => {
      await tx
        .update(schema.listings)
        .set({ status: 'pending_payment' })
        .where(eq(schema.listings.id, listing.id));

      const [newOrder] = await tx
        .insert(schema.orders)
        .values({
          buyerId,
          sellerId: listing.sellerId,
          listingId: listing.id,
          totalInCents: listing.priceInCents ?? 0,
          status: 'pending',
        })
        .returning();

      return newOrder;
    });

    // Cria o PaymentIntent após confirmar o pedido no DB
    const paymentIntent = await this.stripeService.stripe.paymentIntents.create(
      {
        amount: order.totalInCents,
        currency: 'brl',
        automatic_payment_methods: { enabled: true },
        metadata: {
          orderId: order.id,
          buyerId,
          sellerId: listing.sellerId,
        },
      },
      {
        idempotencyKey: `order-${order.id}`,
      },
    );

    this.logger.log(
      `PaymentIntent ${paymentIntent.id} criado para Order ${order.id} (${order.totalInCents / 100} BRL)`,
    );

    return {
      clientSecret: paymentIntent.client_secret,
      orderId: order.id,
      totalInCents: order.totalInCents,
    };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async findBuyerOrders(buyerId: string) {
    return this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.buyerId, buyerId));
  }

  async findById(orderId: string, userId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) throw new NotFoundException('Pedido não encontrado');

    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException('Acesso negado a este pedido');
    }

    return order;
  }

  async findSellerOrders(sellerId: string) {
    return this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.sellerId, sellerId));
  }

  async updateOrderStatus(
    sellerId: string,
    orderId: string,
    dto: UpdateOrderStatusDto,
  ) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) {
      throw new NotFoundException('Pedido não encontrado');
    }

    if (order.sellerId !== sellerId) {
      throw new ForbiddenException('Acesso negado para este pedido');
    }

    const [updated] = await this.db
      .update(schema.orders)
      .set({
        status: dto.status,
        ...(dto.trackingCode && { trackingCode: dto.trackingCode }),
      })
      .where(eq(schema.orders.id, orderId))
      .returning();

    return updated;
  }

  // ── Webhook Handlers ───────────────────────────────────────────────────────

  @OnEvent('stripe.checkout.completed')
  async handleCheckoutCompleted(session: any) {
    this.logger.log(`Processando webhook checkout.completed da Sessão Stripe: ${session.id}`);

    const orderId = session.metadata?.orderId;
    if (!orderId) {
      this.logger.error('Sessão sem orderId no metadata. Ignorando.');
      return;
    }

    await this.confirmOrderPayment(orderId, session.payment_intent || session.id);
  }

  @OnEvent('stripe.payment_intent.succeeded')
  async handlePaymentIntentSucceeded(paymentIntent: any) {
    this.logger.log(`Processando webhook payment_intent.succeeded: ${paymentIntent.id}`);

    const orderId = paymentIntent.metadata?.orderId;
    if (!orderId) {
      this.logger.warn(`PaymentIntent ${paymentIntent.id} sem orderId no metadata. Ignorando.`);
      return;
    }

    await this.confirmOrderPayment(orderId, paymentIntent.id);
  }

  // ── Shared order confirmation logic ───────────────────────────────────────

  private async confirmOrderPayment(orderId: string, stripePaymentId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) {
      this.logger.error(`Pedido ${orderId} não encontrado.`);
      return;
    }

    if (order.status !== 'pending') {
      this.logger.warn(`Pedido ${orderId} já processado. Status atual: ${order.status}`);
      return;
    }

    await this.db.transaction(async (tx: any) => {
      await tx
        .update(schema.orders)
        .set({ status: 'paid', stripePaymentId })
        .where(eq(schema.orders.id, orderId));

      await tx
        .update(schema.listings)
        .set({ status: 'sold' })
        .where(eq(schema.listings.id, order.listingId));
    });

    await this.walletService.hold(
      order.sellerId,
      order.totalInCents,
      `Pagamento Confirmado (Pedido #${order.id.slice(0, 8)})`,
      order.id,
    );

    this.logger.log(
      `✅ Pedido ${order.id} confirmado. Hold de ${order.totalInCents / 100} BRL aplicado ao vendedor ${order.sellerId}.`,
    );
  }
}
