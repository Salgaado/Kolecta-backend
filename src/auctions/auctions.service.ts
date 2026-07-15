import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { eq, and, desc, lte, isNotNull } from 'drizzle-orm';
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
    return this.db
      .select(this.auctionListingSelect)
      .from(schema.auctions)
      .innerJoin(schema.listings, eq(schema.auctions.listingId, schema.listings.id))
      .where(eq(schema.listings.sellerId, sellerId))
      .orderBy(desc(schema.auctions.createdAt));
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

    return this.db.transaction(async (tx: any) => {
      // Registra o lance
      const [bid] = await tx
        .insert(schema.bids)
        .values({
          auctionId,
          bidderId,
          amountInCents: dto.amountInCents,
        })
        .returning();

      // Atualiza o leilão com o novo lance atual
      let newEndsAt = auction.endsAt;

      // Anti-sniper: se o lance for nos últimos 5 minutos, estende por 5 min
      if (
        auction.antiSniper &&
        auction.endsAt &&
        auction.endsAt.getTime() - Date.now() < 5 * 60 * 1000
      ) {
        newEndsAt = new Date(Date.now() + 5 * 60 * 1000);
        this.logger.log(`Anti-sniper ativado: leilão ${auctionId} estendido.`);
      }

      await tx
        .update(schema.auctions)
        .set({
          currentBidInCents: dto.amountInCents,
          currentWinnerId: bidderId,
          endsAt: newEndsAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.auctions.id, auctionId));

      return bid;
    });
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

    await this.db.transaction(async (tx: any) => {
      await tx
        .update(schema.auctions)
        .set({ status: 'ended', updatedAt: new Date() })
        .where(eq(schema.auctions.id, auction.id));

      // Sem lances ou sem vencedor → listing volta a ficar ativo
      if (!auction.currentWinnerId || !auction.currentBidInCents) {
        this.logger.log(`Leilão ${auction.id} encerrado sem vencedor.`);
        return;
      }

      // Reserve price não atingida → sem venda
      if (
        auction.reservePriceInCents &&
        auction.currentBidInCents < auction.reservePriceInCents
      ) {
        this.logger.log(
          `Leilão ${auction.id} encerrado. Reserva não atingida (${auction.currentBidInCents} < ${auction.reservePriceInCents}).`,
        );
        return;
      }

      const totalInCents = auction.currentBidInCents;
      const platformFeeInCents = Math.round(totalInCents * platformFeePercent / 100);
      const stripeFeeInCents = Math.round(totalInCents * 0.04);
      const sellerNetInCents = totalInCents - platformFeeInCents - stripeFeeInCents;

      // Cria o pedido para o vencedor pagar
      await tx.insert(schema.orders).values({
        buyerId: auction.currentWinnerId,
        sellerId: listing!.sellerId,
        listingId: auction.listingId,
        totalInCents,
        sellerNetInCents,
        platformFeeInCents,
        stripeFeeInCents,
        status: 'pending',
      });

      // Marca o anúncio como vendido
      await tx
        .update(schema.listings)
        .set({ status: 'sold' })
        .where(eq(schema.listings.id, auction.listingId));

      this.logger.log(
        `Leilão ${auction.id} encerrado. Vencedor: ${auction.currentWinnerId} — R$${(totalInCents / 100).toFixed(2)}`,
      );
    });
  }
}
