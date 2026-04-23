import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { CreateAuctionDto, PlaceBidDto } from './dto/auction.dto';

@Injectable()
export class AuctionsService {
  private readonly logger = new Logger(AuctionsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  // ── Listar leilões ativos ────────────────────────────────────────────────

  async findAll() {
    return this.db
      .select()
      .from(schema.auctions)
      .where(eq(schema.auctions.status, 'active'));
  }

  // ── Detalhe de um leilão ─────────────────────────────────────────────────

  async findById(auctionId: string) {
    const [auction] = await this.db
      .select()
      .from(schema.auctions)
      .where(eq(schema.auctions.id, auctionId));

    if (!auction) throw new NotFoundException('Leilão não encontrado');
    return auction;
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

  // ── Meus lances (comprador) ──────────────────────────────────────────────

  async findMyBids(bidderId: string) {
    return this.db
      .select()
      .from(schema.bids)
      .where(eq(schema.bids.bidderId, bidderId))
      .orderBy(desc(schema.bids.createdAt));
  }
}
