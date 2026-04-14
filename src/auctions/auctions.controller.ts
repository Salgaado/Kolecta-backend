import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuctionsService } from './auctions.service';
import { CreateAuctionDto, PlaceBidDto } from './dto/auction.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/auctions')
export class AuctionsController {
  constructor(private readonly auctionsService: AuctionsService) {}

  // ── GET /api/auctions — Público: lista leilões ativos ───────────────────

  @Get()
  async findAll() {
    const auctions = await this.auctionsService.findAll();
    return { data: auctions };
  }

  // ── GET /api/auctions/:id — Público: detalhe do leilão ──────────────────

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const auction = await this.auctionsService.findById(id);
    return { data: auction };
  }

  // ── GET /api/auctions/bids/mine — Comprador: meus lances ────────────────

  @Get('bids/mine')
  @UseGuards(AuthGuard)
  async findMyBids(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    const bids = await this.auctionsService.findMyBids(userId);
    return { data: bids };
  }

  // ── POST /api/auctions — Seller: criar leilão ────────────────────────────

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: Request, @Body() dto: CreateAuctionDto) {
    const sellerId = (req as any).auth.userId as string;
    const auction = await this.auctionsService.create(sellerId, dto);
    return { data: auction };
  }

  // ── POST /api/auctions/:id/bids — Comprador: dar lance ─────────────────

  @Post(':id/bids')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async placeBid(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PlaceBidDto,
  ) {
    const bidderId = (req as any).auth.userId as string;
    const bid = await this.auctionsService.placeBid(id, bidderId, dto);
    return { data: bid };
  }
}
