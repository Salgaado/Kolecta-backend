import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { eq, and, desc, lte, lt, ne, or, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { WalletService } from '../wallet/wallet.service';
import { FounderService } from '../founder/founder.service';
import { CardsService } from '../cards/cards.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { buildSplit, PagarmeSplit } from '../pagarme/pagarme-split';
import { CreateAuctionDto, PlaceBidDto } from './dto/auction.dto';

/**
 * Recebedor da plataforma na Pagar.me (destino da comissão no split do arremate).
 * Sem ele, a pré-auth do lance vai sem split (fallback legado). Ver orders.service.
 */
const PLATFORM_RECIPIENT_ID = process.env.PAGARME_PLATFORM_RECIPIENT_ID ?? '';

/**
 * Janela de validade estimada da pré-autorização (dias). A adquirente garante os
 * fundos por ~5 dias; o cron de re-auth (Fase 3) renova antes disso em leilões
 * mais longos. Configurável por `PAGARME_PREAUTH_VALIDITY_DAYS`.
 */
const AUTH_VALIDITY_DAYS = parseInt(
  process.env.PAGARME_PREAUTH_VALIDITY_DAYS ?? '5',
  10,
);

@Injectable()
export class AuctionsService {
  private readonly logger = new Logger(AuctionsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly walletService: WalletService,
    private readonly founderService: FounderService,
    private readonly cardsService: CardsService,
    private readonly pagarme: PagarmeService,
  ) {}

  private readonly auctionListingSelect = {
    id: schema.auctions.id,
    listingId: schema.auctions.listingId,
    startingBidInCents: schema.auctions.startingBidInCents,
    minIncrementInCents: schema.auctions.minIncrementInCents,
    currentBidInCents: schema.auctions.currentBidInCents,
    reservePriceInCents: schema.auctions.reservePriceInCents,
    currentWinnerId: schema.auctions.currentWinnerId,
    durationHours: schema.auctions.durationHours,
    endsAt: schema.auctions.endsAt,
    antiSniper: schema.auctions.antiSniper,
    status: schema.auctions.status,
    createdAt: schema.auctions.createdAt,
    updatedAt: schema.auctions.updatedAt,
    title: schema.listings.title,
    images: schema.listings.images,
    condition: schema.listings.condition,
    sellerId: schema.listings.sellerId,
  };

  // ── Listar leilões ativos (público) ─────────────────────────────────────

  async findAll() {
    return this.db
      .select(this.auctionListingSelect)
      .from(schema.auctions)
      .innerJoin(schema.listings, eq(schema.auctions.listingId, schema.listings.id))
      // endsAt não-nulo = leilão já iniciado (o admin ativou o anúncio);
      // leilões "parados" (anúncio em draft) não aparecem publicamente.
      .where(
        and(
          eq(schema.auctions.status, 'active'),
          isNotNull(schema.auctions.endsAt),
        ),
      );
  }

  // ── Detalhe de um leilão ─────────────────────────────────────────────────

  async findById(auctionId: string) {
    const [row] = await this.db
      .select(this.auctionListingSelect)
      .from(schema.auctions)
      .innerJoin(schema.listings, eq(schema.auctions.listingId, schema.listings.id))
      .where(eq(schema.auctions.id, auctionId));

    if (!row) throw new NotFoundException('Leilão não encontrado');
    return row;
  }

  // ── Leilões do seller (autenticado) ──────────────────────────────────────

  async findSellerAuctions(sellerId: string) {
    const rows = await this.db
      .select(this.auctionListingSelect)
      .from(schema.auctions)
      .innerJoin(schema.listings, eq(schema.auctions.listingId, schema.listings.id))
      .where(eq(schema.listings.sellerId, sellerId))
      .orderBy(desc(schema.auctions.createdAt));

    if (rows.length === 0) return rows;

    // Enriquece com nº de lances por leilão e o NOME do vencedor (o painel do
    // vendedor mostrava "0 lances" e o vencedor como id cru — ver F26).
    const auctionIds = rows.map((r) => r.id);
    const counts = await this.db
      .select({
        auctionId: schema.bids.auctionId,
        total: sql<number>`count(*)`,
      })
      .from(schema.bids)
      .where(inArray(schema.bids.auctionId, auctionIds))
      .groupBy(schema.bids.auctionId);
    const countByAuction = new Map(
      counts.map((c) => [c.auctionId, Number(c.total)]),
    );

    const winnerIds = [
      ...new Set(rows.map((r) => r.currentWinnerId).filter(Boolean)),
    ] as string[];
    const nameByUser = new Map<string, string | null>();
    if (winnerIds.length > 0) {
      const winners = await this.db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(inArray(schema.users.id, winnerIds));
      winners.forEach((u) => nameByUser.set(u.id, u.name ?? null));
    }

    return rows.map((r) => ({
      ...r,
      totalBids: countByAuction.get(r.id) ?? 0,
      winnerName: r.currentWinnerId
        ? (nameByUser.get(r.currentWinnerId) ?? null)
        : null,
    }));
  }

  // ── Criar leilão (seller) ────────────────────────────────────────────────

  async create(sellerId: string, dto: CreateAuctionDto) {
    // Valida se o listing existe e pertence ao seller
    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(
        and(
          eq(schema.listings.id, dto.listingId),
          eq(schema.listings.sellerId, sellerId),
        ),
      );

    if (!listing) {
      throw new NotFoundException(
        'Anúncio não encontrado ou não pertence a você',
      );
    }

    if (listing.type !== 'auction') {
      throw new BadRequestException(
        'O anúncio precisa ser do tipo "auction" para criar um leilão',
      );
    }

    if (listing.status !== 'active') {
      throw new BadRequestException('O anúncio precisa estar ativo');
    }

    const durationHours = dto.durationHours ?? 48;
    const endsAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);

    const [auction] = await this.db
      .insert(schema.auctions)
      .values({
        listingId: dto.listingId,
        startingBidInCents: dto.startingBidInCents,
        minIncrementInCents: dto.minIncrementInCents ?? 1000,
        reservePriceInCents: dto.reservePriceInCents,
        durationHours,
        endsAt,
        antiSniper: dto.antiSniper ?? true,
        status: 'active',
      })
      .returning();

    return auction;
  }

  // ── Dar lance ────────────────────────────────────────────────────────────

  async placeBid(auctionId: string, bidderId: string, dto: PlaceBidDto) {
    const [auction] = await this.db
      .select()
      .from(schema.auctions)
      .where(eq(schema.auctions.id, auctionId));

    if (!auction) throw new NotFoundException('Leilão não encontrado');

    if (auction.status !== 'active') {
      throw new BadRequestException('Este leilão não está mais ativo');
    }

    if (auction.endsAt && auction.endsAt < new Date()) {
      throw new BadRequestException('Este leilão já encerrou');
    }

    // Verifica se o bidder é o próprio seller do listing
    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, auction.listingId));

    if (listing?.sellerId === bidderId) {
      throw new ForbiddenException(
        'Você não pode dar lances no seu próprio leilão',
      );
    }

    // Validação do valor do lance
    const currentBid = auction.currentBidInCents ?? auction.startingBidInCents;
    const minRequired = currentBid + (auction.minIncrementInCents ?? 1000);

    if (dto.amountInCents < minRequired) {
      throw new BadRequestException(
        `Lance mínimo: R$${(minRequired / 100).toFixed(2)}`,
      );
    }

    // ── Cartão salvo obrigatório (lance por cartão) ──
    // O lance é garantido por pré-autorização no cartão. Sem cartão salvo no
    // Financeiro, não há como reter o valor → bloqueia.
    const cardRef = await this.cardsService.getCardRef(bidderId);
    if (!cardRef) {
      throw new BadRequestException(
        'Salve um cartão de crédito no Financeiro para dar lances.',
      );
    }

    // Recebedor do vendedor (p/ split nativo no arremate). Ausente/inapto →
    // pré-auth sem split (fallback legado, igual ao checkout).
    const sellerRecipientId = await this._getSellerRecipientId(listing.sellerId);

    // Vencedor anterior (será superado) + a auth dele (a ser cancelada se
    // ganharmos a corrida). Capturado ANTES de criar a nova auth.
    const prevWinnerId = auction.currentWinnerId;
    const prevAuth = prevWinnerId
      ? await this._getActiveBidAuth(auctionId, prevWinnerId)
      : null;

    // ── Pré-autorização (retenção) no cartão do bidder ──
    // Cria a auth ANTES de assumir a liderança; se perdermos a corrida de
    // concorrência abaixo, cancelamos a auth (rollback). Lança BadRequest com o
    // motivo da Pagar.me quando o cartão é recusado.
    const preAuth = await this._createBidPreAuth({
      customerId: cardRef.customerId,
      cardId: cardRef.cardId,
      amountInCents: dto.amountInCents,
      auctionId,
      bidderId,
      sellerId: listing.sellerId,
      sellerRecipientId,
    });

    let bid: typeof schema.bids.$inferSelect;
    try {
      bid = await this.db.transaction(async (tx: any) => {
        const [newBid] = await tx
          .insert(schema.bids)
          .values({
            auctionId,
            bidderId,
            amountInCents: dto.amountInCents,
            pagarmeOrderId: preAuth.orderId,
            pagarmeChargeId: preAuth.chargeId,
            pagarmeCardId: cardRef.cardId,
            authExpiresAt: preAuth.expiresAt,
          })
          .returning();

        // Anti-sniper: lance nos últimos 5 min estende o leilão em 5 min.
        let newEndsAt = auction.endsAt;
        if (
          auction.antiSniper &&
          auction.endsAt &&
          auction.endsAt.getTime() - Date.now() < 5 * 60 * 1000
        ) {
          newEndsAt = new Date(Date.now() + 5 * 60 * 1000);
          this.logger.log(`Anti-sniper ativado: leilão ${auctionId} estendido.`);
        }

        // Guarda de concorrência: só vence quem supera o lance atual.
        const updated = await tx
          .update(schema.auctions)
          .set({
            currentBidInCents: dto.amountInCents,
            currentWinnerId: bidderId,
            endsAt: newEndsAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.auctions.id, auctionId),
              or(
                isNull(schema.auctions.currentBidInCents),
                lt(schema.auctions.currentBidInCents, dto.amountInCents),
              ),
            ),
          )
          .returning();

        if (updated.length === 0) {
          // Outro lance igual/maior chegou primeiro → desfaz o insert (rollback).
          throw new ConflictException(
            'Outro lance superou o seu. Atualize e tente novamente.',
          );
        }

        // Todos os outros lances ativos do leilão viram 'outbid' — sobra só o
        // novo (líder). Cobre o caso de o bidder subir o próprio lance.
        await tx
          .update(schema.bids)
          .set({ status: 'outbid' })
          .where(
            and(
              eq(schema.bids.auctionId, auctionId),
              eq(schema.bids.status, 'active'),
              ne(schema.bids.id, newBid.id),
            ),
          );

        return newBid;
      });
    } catch (err) {
      // Perdeu a corrida (ou erro) → cancela a retenção recém-criada.
      await this._voidPreAuth(preAuth.chargeId);
      throw err;
    }

    // Ganhou a liderança → cancela a auth do vencedor anterior (best-effort;
    // inclui o próprio bidder quando ele sobe o próprio lance).
    if (prevAuth?.chargeId) {
      await this._voidPreAuth(prevAuth.chargeId);
    }

    return bid;
  }

  // ── Helpers de pré-autorização no cartão ──────────────────────────────────

  /** Recebedor apto do vendedor (p/ split), ou null (→ auth sem split). */
  private async _getSellerRecipientId(
    sellerId: string,
  ): Promise<string | null> {
    const [profile] = await this.db
      .select({
        recipientId: schema.sellerProfiles.pagarmeRecipientId,
        canReceive: schema.sellerProfiles.canReceive,
      })
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, sellerId));
    return profile?.canReceive && profile.recipientId
      ? profile.recipientId
      : null;
  }

  /** Auth vigente (order/charge) do lance ativo de um usuário no leilão. */
  private async _getActiveBidAuth(
    auctionId: string,
    bidderId: string,
  ): Promise<{ chargeId: string | null; orderId: string | null } | null> {
    const [b] = await this.db
      .select({
        chargeId: schema.bids.pagarmeChargeId,
        orderId: schema.bids.pagarmeOrderId,
      })
      .from(schema.bids)
      .where(
        and(
          eq(schema.bids.auctionId, auctionId),
          eq(schema.bids.bidderId, bidderId),
          eq(schema.bids.status, 'active'),
        ),
      );
    return b ?? null;
  }

  /**
   * Cria uma pré-autorização (`capture:false`) no cartão salvo do bidder, no
   * valor do lance. Retorna { orderId, chargeId, expiresAt }. Lança
   * BadRequest com o motivo da Pagar.me quando o cartão é recusado.
   */
  private async _createBidPreAuth(params: {
    customerId: string;
    cardId: string;
    amountInCents: number;
    auctionId: string;
    bidderId: string;
    sellerId: string;
    sellerRecipientId: string | null;
  }): Promise<{ orderId: string; chargeId: string; expiresAt: Date }> {
    // Split nativo no arremate (executado na captura). Sem recebedor apto ou
    // sem recebedor da plataforma → auth sem split (fluxo legado).
    let split: PagarmeSplit[] | undefined;
    if (params.sellerRecipientId && PLATFORM_RECIPIENT_ID) {
      const commissionPct = await this.founderService.resolveCommissionPercent(
        params.sellerId,
      );
      const platformFeeInCents = Math.round(
        (params.amountInCents * commissionPct) / 100,
      );
      split = buildSplit(
        params.sellerRecipientId,
        params.amountInCents,
        platformFeeInCents,
        PLATFORM_RECIPIENT_ID,
      );
    }

    let pagarmeOrder: any;
    try {
      pagarmeOrder = await this.pagarme.post(
        '/orders',
        {
          customer_id: params.customerId,
          items: [
            {
              amount: params.amountInCents,
              description: `Lance Kolecta — leilão ${params.auctionId.slice(0, 8)}`,
              quantity: 1,
              code: 'kolecta-bid',
            },
          ],
          payments: [
            {
              payment_method: 'credit_card',
              credit_card: {
                capture: false, // pré-autorização (retenção sem captura)
                statement_descriptor: 'KOLECTA',
                card_id: params.cardId,
                ...(split ? { split } : {}),
              },
            },
          ],
          metadata: {
            type: 'bid_preauth',
            auctionId: params.auctionId,
            bidderId: params.bidderId,
          },
        },
        // Idempotência por lance (valor + bidder + janela do segundo).
        `bid-preauth-${params.auctionId}-${params.bidderId}-${params.amountInCents}-${Math.floor(Date.now() / 1000)}`,
      );
    } catch {
      throw new BadRequestException(
        'Não foi possível autorizar o valor no seu cartão. Tente outro cartão.',
      );
    }

    const charge = pagarmeOrder?.charges?.[0];
    const authorized =
      pagarmeOrder?.status === 'pending' || // order com charge autorizada
      charge?.status === 'authorized_pending_capture';

    if (!charge?.id || !authorized) {
      const reason =
        charge?.last_transaction?.gateway_response?.errors?.[0]?.message ||
        charge?.last_transaction?.acquirer_message ||
        'Cartão recusado. Verifique os dados ou tente outro cartão.';
      // Cancela a order caso tenha sido criada em estado não-autorizado.
      if (charge?.id) await this._voidPreAuth(charge.id);
      throw new BadRequestException(reason);
    }

    const expiresAt = new Date(
      Date.now() + AUTH_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );
    return { orderId: pagarmeOrder.id, chargeId: charge.id, expiresAt };
  }

  /** Cancela (void) uma pré-autorização. Best-effort — não derruba o fluxo. */
  private async _voidPreAuth(chargeId: string): Promise<void> {
    try {
      await this.pagarme.delete(`/charges/${chargeId}`);
    } catch (err: any) {
      this.logger.warn(
        `Falha ao cancelar pré-auth ${chargeId} (ignorado): ${err?.message}`,
      );
    }
  }

  /** Captura uma pré-autorização no valor informado. Lança se não ficar `paid`. */
  private async _captureCharge(
    chargeId: string,
    amountInCents: number,
  ): Promise<void> {
    const captured = await this.pagarme.post(
      `/charges/${chargeId}/capture`,
      { amount: amountInCents },
      `bid-capture-${chargeId}`,
    );
    if (captured?.status !== 'paid') {
      throw new Error(
        `Captura da pré-auth ${chargeId} não confirmada (status: ${captured?.status}).`,
      );
    }
  }

  // ── Meus lances (comprador) — melhor lance por leilão ────────────────────

  async findMyBids(bidderId: string) {
    const bids = await this.db
      .select({
        id: schema.bids.id,
        auctionId: schema.bids.auctionId,
        amountInCents: schema.bids.amountInCents,
        createdAt: schema.bids.createdAt,
        auctionStatus: schema.auctions.status,
        auctionEndsAt: schema.auctions.endsAt,
        currentBidInCents: schema.auctions.currentBidInCents,
        currentWinnerId: schema.auctions.currentWinnerId,
        listingId: schema.auctions.listingId,
        title: schema.listings.title,
        images: schema.listings.images,
      })
      .from(schema.bids)
      .innerJoin(schema.auctions, eq(schema.bids.auctionId, schema.auctions.id))
      .innerJoin(schema.listings, eq(schema.auctions.listingId, schema.listings.id))
      .where(eq(schema.bids.bidderId, bidderId))
      .orderBy(desc(schema.bids.amountInCents));

    // Mantém apenas o maior lance de cada leilão
    const best = new Map<string, (typeof bids)[number]>();
    for (const bid of bids) {
      if (!best.has(bid.auctionId)) best.set(bid.auctionId, bid);
    }
    return Array.from(best.values());
  }

  // ── Encerrar leilão manualmente (seller/admin) ───────────────────────────

  async endAuction(auctionId: string, requesterId: string) {
    const [auction] = await this.db
      .select()
      .from(schema.auctions)
      .where(eq(schema.auctions.id, auctionId));

    if (!auction) throw new NotFoundException('Leilão não encontrado');
    if (auction.status !== 'active') {
      throw new BadRequestException('O leilão não está mais ativo');
    }

    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, auction.listingId));

    const [requester] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, requesterId));

    const isAdmin = requester?.role === 'admin';

    if (!isAdmin && listing?.sellerId !== requesterId) {
      throw new ForbiddenException(
        'Apenas o vendedor ou um admin pode encerrar este leilão',
      );
    }

    return this._closeAuction(auction, listing);
  }

  // ── Encerrar leilões expirados (usado pelo cron) ─────────────────────────

  async endExpiredAuctions() {
    const now = new Date();
    const expired = await this.db
      .select()
      .from(schema.auctions)
      .where(and(eq(schema.auctions.status, 'active'), lte(schema.auctions.endsAt, now)));

    if (expired.length === 0) return [];

    const results: string[] = [];

    for (const auction of expired) {
      const [listing] = await this.db
        .select()
        .from(schema.listings)
        .where(eq(schema.listings.id, auction.listingId));

      try {
        await this._closeAuction(auction, listing);
        results.push(auction.id);
      } catch (err: any) {
        this.logger.error(`Falha ao fechar leilão ${auction.id}: ${err.message}`);
      }
    }

    return results;
  }

  // ── Lógica interna de fechamento ─────────────────────────────────────────

  private async _closeAuction(auction: typeof schema.auctions.$inferSelect, listing: typeof schema.listings.$inferSelect | undefined) {
    // Comissão efetiva do vendedor (aplica taxa de fundador quando cabível).
    const platformFeePercent = listing?.sellerId
      ? await this.founderService.resolveCommissionPercent(listing.sellerId)
      : parseInt(process.env.PLATFORM_FEE_PERCENT ?? '11', 10);

    const hasWinner = !!auction.currentWinnerId && !!auction.currentBidInCents;
    const reserveMet =
      !auction.reservePriceInCents ||
      (auction.currentBidInCents ?? 0) >= auction.reservePriceInCents;

    // Auth vigente do vencedor (pré-autorização a capturar/cancelar).
    const winnerAuth = hasWinner
      ? await this._getActiveBidAuth(auction.id, auction.currentWinnerId!)
      : null;

    // ── Sem venda: encerra e CANCELA a pré-auth do (eventual) arrematante ──
    if (!hasWinner || !reserveMet) {
      await this.db
        .update(schema.auctions)
        .set({ status: 'ended', updatedAt: new Date() })
        .where(eq(schema.auctions.id, auction.id));

      if (hasWinner) {
        // Reserva não atingida → libera a retenção no cartão do arrematante.
        if (winnerAuth?.chargeId) await this._voidPreAuth(winnerAuth.chargeId);
        await this.db
          .update(schema.bids)
          .set({ status: 'released' })
          .where(
            and(
              eq(schema.bids.auctionId, auction.id),
              eq(schema.bids.status, 'active'),
            ),
          );
        this.logger.log(
          `Leilão ${auction.id} encerrado sem venda (reserva não atingida). Pré-auth cancelada.`,
        );
      } else {
        this.logger.log(`Leilão ${auction.id} encerrado sem vencedor.`);
      }
      return;
    }

    // ── Venda: CAPTURA a pré-auth do vencedor (arremate por cartão) ──
    const totalInCents = auction.currentBidInCents!;
    const platformFeeInCents = Math.round(
      (totalInCents * platformFeePercent) / 100,
    );
    // Split nativo desconta a taxa do gateway do vendedor (charge_processing_fee);
    // o valor real é reconciliado à parte (ponta P-fee do plano). Aqui, 0.
    const sellerNetInCents = totalInCents - platformFeeInCents;

    // Captura a retenção no cartão. Falha (auth expirada/recusada) → Fase 4:
    // pedido/anúncio ficam 'pending_payment' para o vencedor pagar no prazo.
    try {
      if (!winnerAuth?.chargeId) {
        throw new Error('sem pré-auth vigente para capturar');
      }
      await this._captureCharge(winnerAuth.chargeId, totalInCents);
    } catch (err: any) {
      const orderId: string = await this.db.transaction(async (tx: any) => {
        await tx
          .update(schema.auctions)
          .set({ status: 'ended', updatedAt: new Date() })
          .where(eq(schema.auctions.id, auction.id));
        const [order] = await tx
          .insert(schema.orders)
          .values({
            buyerId: auction.currentWinnerId!,
            sellerId: listing!.sellerId,
            listingId: auction.listingId,
            totalInCents,
            sellerNetInCents,
            platformFeeInCents,
            gatewayFeeInCents: 0,
            status: 'pending_payment',
            paymentMethod: 'external',
            paymentInstrument: 'credit_card',
            externalAmountInCents: totalInCents,
            walletAmountInCents: 0,
          })
          .returning();
        await tx
          .update(schema.listings)
          .set({ status: 'pending_payment' })
          .where(eq(schema.listings.id, auction.listingId));
        return order.id as string;
      });
      this.logger.error(
        `⚠️ Leilão ${auction.id}: captura da pré-auth falhou (${err?.message}). ` +
          `Pedido ${orderId} → 'pending_payment' (aguardando pagamento do vencedor — Fase 4).`,
      );
      return;
    }

    // Captura OK → cria pedido pago e retém o líquido do vendedor (espelho).
    const orderId: string = await this.db.transaction(async (tx: any) => {
      await tx
        .update(schema.auctions)
        .set({ status: 'ended', updatedAt: new Date() })
        .where(eq(schema.auctions.id, auction.id));

      const [order] = await tx
        .insert(schema.orders)
        .values({
          buyerId: auction.currentWinnerId!,
          sellerId: listing!.sellerId,
          listingId: auction.listingId,
          totalInCents,
          sellerNetInCents,
          platformFeeInCents,
          gatewayFeeInCents: 0,
          status: 'paid',
          paymentMethod: 'external',
          paymentInstrument: 'credit_card',
          pagarmeOrderId: winnerAuth!.orderId,
          pagarmeChargeId: winnerAuth!.chargeId,
          walletAmountInCents: 0,
          externalAmountInCents: totalInCents,
        })
        .returning();

      await tx
        .update(schema.listings)
        .set({ status: 'sold' })
        .where(eq(schema.listings.id, auction.listingId));

      await tx
        .update(schema.bids)
        .set({ status: 'won' })
        .where(
          and(
            eq(schema.bids.auctionId, auction.id),
            eq(schema.bids.bidderId, auction.currentWinnerId!),
            eq(schema.bids.status, 'active'),
          ),
        );

      return order.id as string;
    });

    // Espelha o líquido do vendedor como retido na wallet (buyer protection).
    // Se o split nativo colocou o líquido no recebedor do vendedor, este é o
    // espelho contábil; o release/saque segue o fluxo das Fases 4/5.
    try {
      const sellerWallet = await this.walletService.getOrCreateWallet(
        listing!.sellerId,
      );
      await this.walletService.hold(
        sellerWallet.id,
        sellerNetInCents,
        `Venda por leilão #${orderId.slice(0, 8)} — líquido retido`,
        orderId,
      );
    } catch (err: any) {
      this.logger.error(
        `⚠️ Leilão ${auction.id}: pedido ${orderId} pago, mas falhou o espelho do líquido do vendedor (${err?.message}).`,
      );
    }

    this.logger.log(
      `Leilão ${auction.id} arrematado por cartão: ${auction.currentWinnerId} — R$${(totalInCents / 100).toFixed(2)} (líquido ${sellerNetInCents / 100}).`,
    );
  }
}
