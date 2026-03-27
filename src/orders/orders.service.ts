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

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly walletService: WalletService,
  ) {}

  async createOrders(buyerId: string, dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('O carrinho está vazio');
    }

    const listingIds = dto.items.map((i) => i.listingId);

    // Buscar os listings para validar o estado antes da compra
    const existingListings = await this.db
      .select()
      .from(schema.listings)
      .where(inArray(schema.listings.id, listingIds));

    if (existingListings.length !== listingIds.length) {
      throw new NotFoundException(
        'Um ou mais anúncios não foram encontrados no sistema',
      );
    }

    // Validações de negócio de bloqueio preemptivo (Fail-Fast)
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

    // Roda tudo dentro de uma transação. Se falhar, faz rollback automático.
    return await this.db.transaction(async (tx) => {
      const createdOrders = [];

      for (const listing of existingListings) {
        // Bloqueia o item mudando para 'pending_payment'
        await tx
          .update(schema.listings)
          .set({ status: 'pending_payment' })
          .where(eq(schema.listings.id, listing.id));

        // Cria o registro da intenção de compra (Pedido / Order) associado unicamente ao listing
        const [newOrder] = await tx
          .insert(schema.orders)
          .values({
            buyerId,
            sellerId: listing.sellerId,
            listingId: listing.id,
            totalInCents: listing.priceInCents ?? 0,
            status: 'pending', // Pagamento Pendente
          })
          .returning();

        createdOrders.push(newOrder);
      }

      return createdOrders;
    });
  }

  async findBuyerOrders(buyerId: string) {
    return this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.buyerId, buyerId));
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

    // Apenas admins ou o próprio vendedor podem alterar o status (admin logic pode ser no controller extra bypassing sellerId)
    if (order.sellerId !== sellerId) {
      throw new ForbiddenException('Acesso negado para este pedido');
    }

    // O retorno da atualização
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

  @OnEvent('stripe.checkout.completed')
  async handleCheckoutCompleted(session: any) {
    this.logger.log(`Processando webhook checkout.completed da Sessão Stripe: ${session.id}`);
    
    const orderId = session.metadata?.orderId;
    if (!orderId) {
      this.logger.error('Sessão sem orderId no metadata. Ignorando.');
      return;
    }

    const [order] = await this.db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    if (!order) {
      this.logger.error(`Pedido ${orderId} não encontrado.`);
      return;
    }

    if (order.status !== 'pending') {
      this.logger.warn(`Pedido ${orderId} já alterado anteriormente. Status atual: ${order.status}`);
      return;
    }
    
    await this.db.transaction(async (tx: any) => {
      await tx.update(schema.orders).set({
        status: 'paid',
        stripePaymentId: session.payment_intent || session.id
      }).where(eq(schema.orders.id, orderId));

      await tx.update(schema.listings)
        .set({ status: 'sold' })
        .where(eq(schema.listings.id, order.listingId));
    });

    await this.walletService.hold(
      order.sellerId, 
      order.totalInCents, 
      `Pagamento Confirmado (Pedido #${order.id.slice(0, 8)})`, 
      order.id
    );
    this.logger.log(`✅ Pagamento Confirmado! Pedido ${order.id}. Hold de ${order.totalInCents / 100} BRL aplicado à carteira do vendedor ${order.sellerId}.`);
  }
}
