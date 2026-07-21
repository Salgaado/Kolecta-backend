import {
  Inject,
  Injectable,
  BadRequestException,
  BadGatewayException,
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
import { PagarmeService } from '../pagarme/pagarme.service';
import { FounderService } from '../founder/founder.service';

/**
 * Taxa do gateway (Pagar.me) descontada do líquido do vendedor, em %.
 * PIX tem custo muito menor que cartão; o valor real depende do contrato da
 * conta. Default 0 (Kolecta absorve) até o número real ser confirmado — NÃO
 * chutamos um valor para não lesar o vendedor. Ver `PAGARME_GATEWAY_FEE_PERCENT`.
 * Substitui o antigo `~4%` hardcoded que era estimativa da Stripe (bug B4).
 */
const GATEWAY_FEE_PERCENT = parseFloat(
  process.env.PAGARME_GATEWAY_FEE_PERCENT ?? '0',
);

/** Validade do QR Code PIX da compra, em segundos (1h). */
const PIX_EXPIRES_IN_SECONDS = 3600;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly walletService: WalletService,
    private readonly pagarme: PagarmeService,
    private readonly eventEmitter: EventEmitter2,
    private readonly founderService: FounderService,
  ) {}

  // ── Create orders (legacy — sem PaymentIntent) ─────────────────────────────

  /**
   * Persiste o CPF do comprador (só dígitos) em `users.cpf` para reuso nas
   * transações Pagar.me. Dado sensível (LGPD): não é logado. No-op se ausente.
   */
  private async persistBuyerCpf(buyerId: string, cpf?: string) {
    if (!cpf) return;
    const digits = cpf.replace(/\D/g, '');
    await this.db
      .update(schema.users)
      .set({ cpf: digits, updatedAt: new Date() })
      .where(eq(schema.users.id, buyerId));
  }

  async createOrders(buyerId: string, dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('O carrinho está vazio');
    }

    await this.persistBuyerCpf(buyerId, dto.buyerCpf);

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

  // ── Checkout: pedido + pagamento (wallet + PIX Pagar.me) ────────────────────

  /**
   * Cria o pedido e resolve o pagamento:
   *  - 100% wallet  → debita e confirma na hora (síncrono, sem gateway).
   *  - wallet+PIX ou só PIX → gera cobrança PIX na Pagar.me e devolve o QR.
   *    A confirmação do pedido só acontece no webhook `order.paid`
   *    (→ evento `pagarme.order.paid` → `confirmOrderPayment`).
   *
   * Substitui o antigo fluxo Stripe (`paymentIntents.create`). O caso híbrido
   * mantém o comportamento atual de debitar a parcela da wallet já no checkout;
   * se o PIX falhar/expirar, o handler `pagarme.order.failed` estorna.
   */
  async createCheckout(buyerId: string, dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('O carrinho está vazio');
    }

    await this.persistBuyerCpf(buyerId, dto.buyerCpf);

    // MVP: 1 item por chamada (uma cobrança por vendedor)
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

    const paymentMethod =
      chargeAmount <= 0 ? 'wallet' : walletDeducted > 0 ? 'hybrid' : 'external';

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
          walletAmountInCents: walletDeducted,
          externalAmountInCents: chargeAmount,
          paymentMethod,
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

    // ── Caso 2: Deduz parcial da wallet + cobra restante via PIX ──
    if (walletDeducted > 0) {
      const wallet = await this.walletService.getOrCreateWallet(buyerId);
      await this.walletService.debit(
        wallet.id,
        walletDeducted,
        `Abatimento parcial - Compra #${order.id.slice(0, 8)}`,
        order.id,
      );
      this.logger.log(
        `Abatido ${walletDeducted / 100} BRL da wallet. Restante: ${chargeAmount / 100} BRL via PIX.`,
      );
    }

    // Dados do comprador para o customer da Pagar.me (nome/email/cpf)
    const [buyer] = await this.db
      .select({
        name: schema.users.name,
        email: schema.users.email,
        cpf: schema.users.cpf,
      })
      .from(schema.users)
      .where(eq(schema.users.id, buyerId));

    const cpfDigits = (dto.buyerCpf || buyer?.cpf || '').replace(/\D/g, '');
    if (!cpfDigits) {
      throw new BadRequestException(
        'CPF é obrigatório para gerar o pagamento via PIX.',
      );
    }

    // Telefone é exigido pela Pagar.me para PIX ("At least one customer phone
    // is required"). DDD (2 primeiros dígitos) + número (restante).
    const phoneDigits = (dto.buyerPhone || '').replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      throw new BadRequestException(
        'Telefone (com DDD) é obrigatório para gerar o pagamento via PIX.',
      );
    }
    const areaCode = phoneDigits.slice(0, 2);
    const phoneNumber = phoneDigits.slice(2);

    // Cria a cobrança PIX na Pagar.me para o valor restante
    const pixOrder = await this.pagarme.post<PagarmeOrderResponse>(
      '/orders',
      {
        items: [
          {
            amount: chargeAmount,
            description: `Compra Kolecta #${order.id.slice(0, 8)}`,
            quantity: 1,
            code: 'kolecta-order',
          },
        ],
        customer: {
          name: buyer?.name || 'Comprador Kolecta',
          email: buyer?.email,
          type: 'individual',
          document: cpfDigits,
          document_type: 'CPF',
          phones: {
            mobile_phone: {
              country_code: '55',
              area_code: areaCode,
              number: phoneNumber,
            },
          },
        },
        payments: [
          {
            payment_method: 'pix',
            pix: { expires_in: PIX_EXPIRES_IN_SECONDS },
          },
        ],
        metadata: {
          type: 'purchase',
          orderId: order.id,
          buyerId,
          sellerId: listing.sellerId,
          walletDeducted: String(walletDeducted),
        },
      },
      `order-${order.id}`, // Idempotency-Key estável por pedido
    );

    const charge = pixOrder.charges?.[0];
    const tx = charge?.last_transaction;

    // A Pagar.me responde 200 mesmo quando a transação falha (status no corpo).
    if (!tx?.qr_code) {
      this.logger.error(
        `Falha ao gerar PIX da compra (order ${order.id} / pagarme ${pixOrder.id}, ` +
          `status ${pixOrder.status}): ${JSON.stringify(tx?.gateway_response ?? {})}`,
      );
      // Devolve o listing e cancela o pedido para não deixar item travado.
      await this.db.transaction(async (t: any) => {
        await t
          .update(schema.orders)
          .set({ status: 'cancelled' })
          .where(eq(schema.orders.id, order.id));
        await t
          .update(schema.listings)
          .set({ status: 'active' })
          .where(eq(schema.listings.id, listing.id));
      });
      // Estorna o abatimento parcial da wallet, se houve.
      if (walletDeducted > 0) {
        const wallet = await this.walletService.getOrCreateWallet(buyerId);
        await this.walletService.credit(
          wallet.id,
          walletDeducted,
          `Estorno - falha ao gerar PIX da compra #${order.id.slice(0, 8)}`,
          order.id,
        );
      }
      throw new BadGatewayException(
        'Não foi possível gerar o PIX no momento. Tente novamente.',
      );
    }

    // Persiste o id do pedido Pagar.me (coluna stripePaymentId reaproveitada até
    // a renomeação da Fase 2 → pagarme_order_id).
    await this.db
      .update(schema.orders)
      .set({ stripePaymentId: pixOrder.id })
      .where(eq(schema.orders.id, order.id));

    this.logger.log(
      `PIX de compra criado: order ${order.id} / pagarme ${pixOrder.id} / ` +
        `R$ ${(chargeAmount / 100).toFixed(2)} (wallet ${walletDeducted / 100})`,
    );

    return {
      orderId: order.id,
      pagarmeOrderId: pixOrder.id,
      totalInCents,
      walletDeducted,
      chargeAmount,
      qrCode: tx.qr_code, // copia-e-cola
      qrCodeUrl: tx.qr_code_url, // imagem do QR
      expiresAt: tx.expires_at,
      paidViaWallet: false,
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

  // ── Webhook Handlers (Pagar.me) ────────────────────────────────────────────

  /**
   * PIX de compra pago. Emitido pelo webhook unificado da Pagar.me quando
   * `order.paid` chega SEM `metadata.type === 'wallet_deposit'` (depósito é
   * tratado à parte). O `data` é o objeto de pedido da Pagar.me.
   */
  @OnEvent('pagarme.order.paid')
  async handlePagarmeOrderPaid(data: any) {
    const orderId = data?.metadata?.orderId;
    if (!orderId) {
      this.logger.warn(
        `Pagar.me order.paid (${data?.id}) sem orderId no metadata. Ignorando.`,
      );
      return;
    }

    this.logger.log(
      `Processando order.paid da Pagar.me: pedido ${orderId} (pagarme ${data?.id})`,
    );
    await this.confirmOrderPayment(orderId, data?.id ?? 'pagarme');
  }

  /**
   * PIX de compra falhou/expirou/cancelado. Estorna o abatimento parcial da
   * wallet (se houve) e devolve o anúncio para `active`. Idempotente.
   */
  @OnEvent('pagarme.order.failed')
  async handlePagarmeOrderFailed(data: any) {
    const orderId = data?.metadata?.orderId;
    if (!orderId) {
      this.logger.warn(
        `Pagar.me order.failed (${data?.id}) sem orderId no metadata. Ignorando.`,
      );
      return;
    }

    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) {
      this.logger.warn(`order.failed: pedido ${orderId} não encontrado.`);
      return;
    }
    // Só age em pedidos ainda pendentes (idempotência).
    if (order.status !== 'pending') {
      this.logger.warn(
        `order.failed: pedido ${orderId} já está '${order.status}'. Ignorando.`,
      );
      return;
    }

    await this.db.transaction(async (tx: any) => {
      await tx
        .update(schema.orders)
        .set({ status: 'cancelled' })
        .where(eq(schema.orders.id, orderId));
      await tx
        .update(schema.listings)
        .set({ status: 'active' })
        .where(eq(schema.listings.id, order.listingId));
    });

    // Estorna a parcela debitada da wallet no checkout, se houve.
    const walletRefund = order.walletAmountInCents ?? 0;
    if (walletRefund > 0) {
      const wallet = await this.walletService.getOrCreateWallet(order.buyerId);
      await this.walletService.credit(
        wallet.id,
        walletRefund,
        `Estorno - PIX não concluído (Compra #${order.id.slice(0, 8)})`,
        order.id,
      );
    }

    this.logger.warn(
      `↩️ Pedido ${orderId} cancelado (PIX não concluído). ` +
        `Anúncio reativado; wallet estornada em ${walletRefund / 100} BRL.`,
    );
  }

  // ── Shared order confirmation logic ───────────────────────────────────────

  private async confirmOrderPayment(orderId: string, providerPaymentId: string) {
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

    // Calcular taxas conforme fluxo canônico.
    // Comissão efetiva resolve a taxa de fundador (9% por 6 meses) quando aplicável.
    const platformFeePercent = await this.founderService.resolveCommissionPercent(
      order.sellerId,
    );
    const platformFeeInCents = Math.round(order.totalInCents * platformFeePercent / 100);
    // Taxa do gateway (Pagar.me): incide apenas sobre o valor pago externamente
    // (PIX), não sobre a parcela paga com saldo da wallet. Percentual configurável
    // via env; default 0 até o custo real do contrato ser confirmado (bug B4).
    const externalInCents = order.externalAmountInCents ?? order.totalInCents;
    const gatewayFeeInCents = Math.round(externalInCents * GATEWAY_FEE_PERCENT / 100);
    const sellerNetInCents = order.totalInCents - platformFeeInCents - gatewayFeeInCents;

    await this.db.transaction(async (tx: any) => {
      await tx
        .update(schema.orders)
        .set({
          status: 'paid',
          // Coluna stripePaymentId reaproveitada p/ o id do provedor (Pagar.me)
          // até a renomeação da Fase 2 → pagarme_order_id.
          stripePaymentId: providerPaymentId,
          sellerNetInCents,
          platformFeeInCents,
          // Coluna stripeFeeInCents reaproveitada p/ a taxa de gateway
          // (renomear p/ gateway_fee_in_cents na Fase 2).
          stripeFeeInCents: gatewayFeeInCents,
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
      `✅ Pedido ${order.id} confirmado. Hold de ${sellerNetInCents / 100} BRL (bruto: ${order.totalInCents / 100}, taxa plataforma: ${platformFeeInCents / 100}, taxa gateway: ${gatewayFeeInCents / 100})`,
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

// ── Tipagem mínima da resposta de /orders da Pagar.me (PIX) ───────────────────
interface PagarmeTransaction {
  qr_code?: string;
  qr_code_url?: string;
  expires_at?: string;
  status?: string;
  gateway_response?: unknown;
}

interface PagarmeCharge {
  id?: string;
  status?: string;
  last_transaction?: PagarmeTransaction;
}

interface PagarmeOrderResponse {
  id: string;
  status: string;
  charges?: PagarmeCharge[];
}

