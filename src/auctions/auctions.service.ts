import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { eq, and, desc, lte, lt, or, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { WalletService } from '../wallet/wallet.service';
import { FounderService } from '../founder/founder.service';
import { CreateAuctionDto, PlaceBidDto } from './dto/auction.dto';

@Injectable()
export class AuctionsService {
  private readonly logger = new Logger(AuctionsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly walletService: WalletService,
    private readonly founderService: FounderService,
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

    // ── Gate de saldo (Fase 6): lance exige saldo DISPONÍVEL na wallet ──
    // Se o bidder já é o vencedor atual, o hold atual dele conta a favor (ao
    // subir o próprio lance, o hold antigo é destravado antes de travar o novo).
    const bidderPrevHold =
      auction.currentWinnerId === bidderId
        ? auction.currentBidInCents ?? 0
        : 0;
    const bidderWalletPre = await this.walletService.getOrCreateWallet(bidderId);
    if (bidderWalletPre.balanceInCents + bidderPrevHold < dto.amountInCents) {
      throw new BadRequestException(
        'Saldo disponível insuficiente para este lance. Deposite para participar.',
      );
    }

    // Vencedor anterior (será superado) — capturado da leitura acima. A guarda
    // de concorrência no UPDATE garante a monotonicidade do valor; em corridas
    // raras o prev pode ser levemente defasado (ver nota de reconciliação).
    const prevWinnerId = auction.currentWinnerId;
    const prevAmount = auction.currentBidInCents;

    const bid = await this.db.transaction(async (tx: any) => {
      const [newBid] = await tx
        .insert(schema.bids)
        .values({ auctionId, bidderId, amountInCents: dto.amountInCents })
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

      // Marca o lance vencedor anterior como superado (status do ciclo).
      if (prevWinnerId) {
        await tx
          .update(schema.bids)
          .set({ status: 'outbid' })
          .where(
            and(
              eq(schema.bids.auctionId, auctionId),
              eq(schema.bids.bidderId, prevWinnerId),
              eq(schema.bids.status, 'active'),
            ),
          );
      }

      return newBid;
    });

    // ── Ajuste dos holds (fora da tx — padrão do WalletService) ──
    // NOTA: o hold é ajustado após o commit do lance; a checagem de saldo acima
    // torna a falha improvável. Se algum ajuste falhar, o lance permanece e o
    // desajuste do hold precisa de reconciliação (raro; ver plano Fase 6).
    // Destrava o hold do lance anterior (superado) — inclui o próprio bidder
    // quando ele sobe o próprio lance.
    if (prevWinnerId && prevAmount && prevAmount > 0) {
      const prevWallet = await this.walletService.getOrCreateWallet(prevWinnerId);
      await this.walletService.releaseBidHold(prevWallet.id, prevAmount, {
        auctionId,
        description: `Lance superado — leilão ${auctionId.slice(0, 8)}`,
      });
    }
    // Trava o valor do novo lance vencedor.
    const bidderWallet = await this.walletService.getOrCreateWallet(bidderId);
    await this.walletService.holdForBid(bidderWallet.id, dto.amountInCents, {
      auctionId,
      bidId: bid.id,
      description: `Hold de lance — leilão ${auctionId.slice(0, 8)}`,
    });

    return bid;
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

    // ── Sem venda: encerra e destrava o hold do (eventual) arrematante ──
    if (!hasWinner || !reserveMet) {
      await this.db
        .update(schema.auctions)
        .set({ status: 'ended', updatedAt: new Date() })
        .where(eq(schema.auctions.id, auction.id));

      if (hasWinner) {
        // Reserva não atingida → devolve o valor travado ao arrematante.
        const w = await this.walletService.getOrCreateWallet(
          auction.currentWinnerId!,
        );
        await this.walletService.releaseBidHold(w.id, auction.currentBidInCents!, {
          auctionId: auction.id,
          description: `Leilão ${auction.id.slice(0, 8)} sem venda (reserva) — hold liberado`,
        });
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
          `Leilão ${auction.id} encerrado sem venda (reserva não atingida). Hold liberado.`,
        );
      } else {
        this.logger.log(`Leilão ${auction.id} encerrado sem vencedor.`);
      }
      return;
    }

    // ── Venda: cria pedido PAGO, liquidado do hold do vencedor ──
    const totalInCents = auction.currentBidInCents!;
    const platformFeeInCents = Math.round(
      (totalInCents * platformFeePercent) / 100,
    );
    // Arremate é pago com SALDO (hold da wallet) — sem cobrança de gateway,
    // logo sem taxa de gateway (corrige o antigo 4% hardcoded, bug B4).
    const sellerNetInCents = totalInCents - platformFeeInCents;

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
          paymentMethod: 'wallet',
          walletAmountInCents: totalInCents,
          externalAmountInCents: 0,
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

    // Liquida o hold do vencedor (débito efetivo) e retém o líquido do vendedor.
    // Se o hold não existir (leilão anterior ao recurso), volta o pedido p/
    // 'pending' e loga — pagamento então segue pelo checkout normal.
    try {
      const winnerWallet = await this.walletService.getOrCreateWallet(
        auction.currentWinnerId!,
      );
      await this.walletService.settleBidHold(winnerWallet.id, totalInCents, {
        auctionId: auction.id,
        orderId,
        description: `Arremate leilão ${auction.id.slice(0, 8)}`,
      });

      const sellerWallet = await this.walletService.getOrCreateWallet(
        listing!.sellerId,
      );
      await this.walletService.hold(
        sellerWallet.id,
        sellerNetInCents,
        `Venda por leilão #${orderId.slice(0, 8)} — líquido retido`,
        orderId,
      );

      this.logger.log(
        `Leilão ${auction.id} arrematado: ${auction.currentWinnerId} — R$${(totalInCents / 100).toFixed(2)} (líquido ${sellerNetInCents / 100}).`,
      );
    } catch (err: any) {
      await this.db
        .update(schema.orders)
        .set({ status: 'pending' })
        .where(eq(schema.orders.id, orderId));
      this.logger.error(
        `⚠️ Leilão ${auction.id}: falha ao liquidar hold do vencedor (${err?.message}). ` +
          `Pedido ${orderId} → 'pending' p/ pagamento manual.`,
      );
    }
  }
}
