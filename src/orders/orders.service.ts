import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WalletService } from '../wallet/wallet.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
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
    private readonly eventEmitter: EventEmitter2,
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

        const price: number = listing.priceInCents ?? 0;

        const [newOrder] = await tx
          .insert(schema.orders)
          .values({
            buyerId,
            sellerId: listing.sellerId,
            listingId: listing.id,
            totalInCents: price,
            status: 'pending',
          })
          .returning();

        createdOrders.push(newOrder);
      }

      return createdOrders;
    });
  }

  // ── Create order + PaymentIntent (checkout híbrido: wallet + stripe) ────────

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
      throw new BadRequestException(
        'Este anúncio não está mais disponível para venda',
      );
    }
    if (listing.sellerId === buyerId) {
      throw new ForbiddenException(
        'Você não pode comprar o seu próprio produto',
      );
    }

    const totalInCents: number = listing.priceInCents ?? 0;
    let walletDeducted = 0;
    let chargeAmount = totalInCents;

    // ── Verificar saldo da wallet se solicitado ──
    if (dto.useWalletBalance) {
      const wallet = await this.walletService.getOrCreateWallet(buyerId);
      walletDeducted = Math.min(wallet.balanceInCents, totalInCents);
      chargeAmount = totalInCents - walletDeducted;
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
          totalInCents,
          status: 'pending',
        })
        .returning();

      return newOrder;
    });

    // ── Caso 1: Saldo da wallet cobre 100% do valor ──
    if (chargeAmount <= 0) {
      const wallet = await this.walletService.getOrCreateWallet(buyerId);
      await this.walletService.debit(
        wallet.id,
        walletDeducted,
        `Compra #${order.id.slice(0, 8)} (saldo integral)`,
        order.id,
      );

      // Confirma o pedido imediatamente
      await this.confirmOrderPayment(order.id, `wallet-${wallet.id}`);

      this.logger.log(
        `Pedido ${order.id} pago 100% via wallet (${totalInCents / 100} BRL)`,
      );

      return {
        orderId: order.id,
        totalInCents,
        walletDeducted,
        paidViaWallet: true,
      };
    }

    // ── Caso 2: Deduz parcial da wallet + cobra restante via Stripe ──
    if (walletDeducted > 0) {
      const wallet = await this.walletService.getOrCreateWallet(buyerId);
      await this.walletService.debit(
        wallet.id,
        walletDeducted,
        `Abatimento parcial - Compra #${order.id.slice(0, 8)}`,
        order.id,
      );
      this.logger.log(
        `Abatido ${walletDeducted / 100} BRL da wallet. Restante: ${chargeAmount / 100} BRL via Stripe.`,
      );
    }

    // Cria o PaymentIntent para o valor restante
    const paymentIntent = await this.stripeService.stripeClient.paymentIntents.create(
      {
        amount: chargeAmount,
        currency: 'brl',
        payment_method_types: ['card', 'pix'],
        metadata: {
          orderId: order.id,
          buyerId,
          sellerId: listing.sellerId,
          walletDeducted: String(walletDeducted),
        },
      },
      {
        idempotencyKey: `order-${order.id}`,
      },
    );

    this.logger.log(
      `PaymentIntent ${paymentIntent.id} criado para Order ${order.id} (${chargeAmount / 100} BRL)`,
    );

    return {
      clientSecret: paymentIntent.client_secret,
      orderId: order.id,
      totalInCents,
      walletDeducted,
      chargeAmount,
    };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  // Converte o campo `images` (JSON stringificado ou CSV legado) em array.
  private parseImages(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  async findBuyerOrders(buyerId: string) {
    const rows = await this.db
      .select({
        order: schema.orders,
        listingTitle: schema.listings.title,
        listingImages: schema.listings.images,
        listingPrice: schema.listings.priceInCents,
        counterpartName: schema.users.name,
      })
      .from(schema.orders)
      .leftJoin(schema.listings, eq(schema.orders.listingId, schema.listings.id))
      // Para o comprador, a contraparte é o vendedor
      .leftJoin(schema.users, eq(schema.orders.sellerId, schema.users.id))
      .where(eq(schema.orders.buyerId, buyerId));

    return rows.map((r) => ({
      ...r.order,
      listing: {
        title: r.listingTitle ?? 'Item indisponível',
        images: this.parseImages(r.listingImages),
        priceInCents: r.listingPrice ?? r.order.totalInCents,
      },
      seller: { id: r.order.sellerId, name: r.counterpartName ?? 'Vendedor' },
    }));
  }

  async findById(orderId: string, userId: string) {
    const buyerUser = alias(schema.users, 'buyer_user');
    const sellerUser = alias(schema.users, 'seller_user');

    const [row] = await this.db
      .select({
        order: schema.orders,
        listingTitle: schema.listings.title,
        listingImages: schema.listings.images,
        listingPrice: schema.listings.priceInCents,
        listingCondition: schema.listings.condition,
        buyerName: buyerUser.name,
        sellerName: sellerUser.name,
        address: schema.addresses,
      })
      .from(schema.orders)
      .leftJoin(
        schema.listings,
        eq(schema.orders.listingId, schema.listings.id),
      )
      .leftJoin(buyerUser, eq(schema.orders.buyerId, buyerUser.id))
      .leftJoin(sellerUser, eq(schema.orders.sellerId, sellerUser.id))
      .leftJoin(
        schema.addresses,
        eq(schema.orders.addressId, schema.addresses.id),
      )
      .where(eq(schema.orders.id, orderId));

    if (!row) throw new NotFoundException('Pedido não encontrado');

    const { order } = row;

    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException('Acesso negado a este pedido');
    }

    return {
      ...order,
      listing: {
        title: row.listingTitle ?? 'Item indisponível',
        images: this.parseImages(row.listingImages),
        priceInCents: row.listingPrice ?? order.totalInCents,
        condition: row.listingCondition ?? null,
      },
      buyer: { id: order.buyerId, name: row.buyerName ?? 'Comprador' },
      seller: { id: order.sellerId, name: row.sellerName ?? 'Vendedor' },
      address: row.address ?? null,
    };
  }

  async findSellerOrders(sellerId: string) {
    const rows = await this.db
      .select({
        order: schema.orders,
        listingTitle: schema.listings.title,
        listingImages: schema.listings.images,
        listingPrice: schema.listings.priceInCents,
        counterpartName: schema.users.name,
      })
      .from(schema.orders)
      .leftJoin(schema.listings, eq(schema.orders.listingId, schema.listings.id))
      // Para o vendedor, a contraparte é o comprador
      .leftJoin(schema.users, eq(schema.orders.buyerId, schema.users.id))
      .where(eq(schema.orders.sellerId, sellerId));

    return rows.map((r) => ({
      ...r.order,
      listing: {
        title: r.listingTitle ?? 'Item indisponível',
        images: this.parseImages(r.listingImages),
        priceInCents: r.listingPrice ?? r.order.totalInCents,
      },
      buyer: { id: r.order.buyerId, name: r.counterpartName ?? 'Comprador' },
    }));
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
    this.logger.log(
      `Processando webhook checkout.completed da Sessão Stripe: ${session.id}`,
    );

    const orderId = session.metadata?.orderId;
    if (!orderId) {
      this.logger.error('Sessão sem orderId no metadata. Ignorando.');
      return;
    }

    await this.confirmOrderPayment(
      orderId,
      session.payment_intent || session.id,
    );
  }

  @OnEvent('stripe.payment_intent.succeeded')
  async handlePaymentIntentSucceeded(paymentIntent: any) {
    this.logger.log(
      `Processando webhook payment_intent.succeeded: ${paymentIntent.id}`,
    );

    const orderId = paymentIntent.metadata?.orderId;
    if (!orderId) {
      this.logger.warn(
        `PaymentIntent ${paymentIntent.id} sem orderId no metadata. Ignorando.`,
      );
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
      this.logger.warn(
        `Pedido ${orderId} já processado. Status atual: ${order.status}`,
      );
      return;
    }

    // Calcular taxas conforme fluxo canônico
    const platformFeePercent = parseInt(process.env.PLATFORM_FEE_PERCENT ?? '10', 10);
    const platformFeeInCents = Math.round(order.totalInCents * platformFeePercent / 100);
    // Estimativa da taxa Stripe (~3.99% + R$0.39 para BR, simplificado como ~4%)
    const stripeFeeInCents = Math.round(order.totalInCents * 0.04);
    const sellerNetInCents = order.totalInCents - platformFeeInCents - stripeFeeInCents;

    await this.db.transaction(async (tx: any) => {
      await tx
        .update(schema.orders)
        .set({
          status: 'paid',
          stripePaymentId,
          sellerNetInCents,
          platformFeeInCents,
          stripeFeeInCents,
        })
        .where(eq(schema.orders.id, orderId));

      await tx
        .update(schema.listings)
        .set({ status: 'sold' })
        .where(eq(schema.listings.id, order.listingId));
    });

    // Creditar valor líquido como saldo retido (held_balance) para o vendedor
    const sellerWallet = await this.walletService.getOrCreateWallet(order.sellerId);
    await this.walletService.hold(
      sellerWallet.id,
      sellerNetInCents,
      `Venda #${order.id.slice(0, 8)} — saldo retido (líquido: ${(sellerNetInCents / 100).toFixed(2)} BRL)`,
      order.id,
    );

    this.logger.log(
      `✅ Pedido ${order.id} confirmado. Hold de ${sellerNetInCents / 100} BRL (bruto: ${order.totalInCents / 100}, taxa plataforma: ${platformFeeInCents / 100}, taxa stripe: ${stripeFeeInCents / 100})`,
    );

    // Busca dados do comprador e listing para o evento
    const [buyer] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, order.buyerId));

    const [listing] = await this.db
      .select({ title: schema.listings.title })
      .from(schema.listings)
      .where(eq(schema.listings.id, order.listingId));

    this.eventEmitter.emit('order.paid', {
      orderId: order.id,
      sellerId: order.sellerId,
      buyerId: order.buyerId,
      buyerName: buyer?.name ?? null,
      buyerEmail: buyer?.email ?? '',
      listingTitle: listing?.title ?? 'Item Kolecta',
      totalInCents: order.totalInCents,
    });
  }

  // ── Vendedor marca como entregue → inicia timer 48h ───────────────────────

  async markAsDelivered(sellerId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.sellerId !== sellerId) {
      throw new ForbiddenException('Acesso negado para este pedido');
    }
    if (order.status !== 'shipped' && order.status !== 'paid') {
      throw new BadRequestException(
        `Pedido não pode ser marcado como entregue. Status atual: ${order.status}`,
      );
    }

    const now = new Date();
    const autoReleaseAt = new Date(now.getTime() + 48 * 60 * 60 * 1000); // +48 horas

    const [updated] = await this.db
      .update(schema.orders)
      .set({
        status: 'delivered',
        deliveredAt: now,
        autoReleaseAt,
      })
      .where(eq(schema.orders.id, orderId))
      .returning();

    this.logger.log(
      `📦 Pedido ${orderId} marcado como entregue. Auto-release em ${autoReleaseAt.toISOString()}`,
    );

    return updated;
  }

  // ── Comprador confirma recebimento → libera saldo do vendedor ─────────────

  async confirmDelivery(buyerId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.buyerId !== buyerId) {
      throw new ForbiddenException('Apenas o comprador pode confirmar recebimento');
    }
    if (order.status !== 'delivered' && order.status !== 'shipped') {
      throw new BadRequestException(
        `Pedido não pode ser confirmado. Status atual: ${order.status}`,
      );
    }

    const now = new Date();
    const sellerNetInCents = order.sellerNetInCents || order.totalInCents;

    // Liberar saldo retido do vendedor → saldo disponível
    const sellerWallet = await this.walletService.getOrCreateWallet(order.sellerId);
    await this.walletService.release(
      sellerWallet.id,
      sellerNetInCents,
      `Liberação — Comprador confirmou recebimento (Pedido #${order.id.slice(0, 8)})`,
      order.id,
    );

    const [updated] = await this.db
      .update(schema.orders)
      .set({
        status: 'completed',
        buyerConfirmedAt: now,
        completedAt: now,
      })
      .where(eq(schema.orders.id, orderId))
      .returning();

    this.logger.log(
      `✅ Pedido ${orderId} completado. Saldo de ${sellerNetInCents / 100} BRL liberado para o vendedor ${order.sellerId}`,
    );

    return updated;
  }
}

