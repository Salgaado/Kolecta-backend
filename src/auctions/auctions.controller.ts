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
import {
  CreateAuctionDto,
  PlaceBidDto,
  ChooseAuctionShippingDto,
} from './dto/auction.dto';
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

  // ── GET /api/auctions/seller/mine — Seller: meus leilões ─────────────────

  @Get('seller/mine')
  @UseGuards(AuthGuard)
  async findSellerAuctions(@Req() req: Request) {
    const sellerId = (req as any).auth.userId as string;
    const auctions = await this.auctionsService.findSellerAuctions(sellerId);
    return { data: auctions };
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

  // ── POST /api/auctions/:id/end — Seller/Admin: encerrar leilão ──────────

  @Post(':id/end')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  async endAuction(@Req() req: Request, @Param('id') id: string) {
    const userId = (req as any).auth.userId as string;
    const result = await this.auctionsService.endAuction(id, userId);
    return { data: result };
  }

  // ── GET /api/auctions/orders/:orderId/shipping — Opções de entrega do vencedor ──
  // Leilão não tem checkout: o vencedor escolhe o frete AQUI, depois do fecho.
  // Devolve as opções cotadas para o endereço dele, já com o total (lance +
  // frete) de cada uma.

  @Get('orders/:orderId/shipping')
  @UseGuards(AuthGuard)
  async auctionShippingOptions(
    @Req() req: Request,
    @Param('orderId') orderId: string,
  ) {
    const buyerId = (req as any).auth.userId as string;
    const data = await this.auctionsService.getAuctionShippingOptions(
      buyerId,
      orderId,
    );
    return { data };
  }

  // ── POST /api/auctions/orders/:orderId/shipping — Vencedor escolhe a entrega ──
  // Grava a escolha e soma o frete ao total do arremate. O preço vem da
  // recotagem no servidor, não do corpo do request.

  @Post('orders/:orderId/shipping')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async chooseAuctionShipping(
    @Req() req: Request,
    @Param('orderId') orderId: string,
    @Body() dto: ChooseAuctionShippingDto,
  ) {
    const buyerId = (req as any).auth.userId as string;
    const data = await this.auctionsService.chooseShipping(
      buyerId,
      orderId,
      dto,
    );
    return { data };
  }

  // ── POST /api/auctions/orders/:orderId/pay — Vencedor paga o arremate ──
  // Cobra `lance + frete` no cartão salvo, dentro do prazo. Exige que a entrega
  // já tenha sido escolhida.

  @Post('orders/:orderId/pay')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async payAuctionOrder(
    @Req() req: Request,
    @Param('orderId') orderId: string,
  ) {
    const buyerId = (req as any).auth.userId as string;
    const result = await this.auctionsService.payAuctionOrder(buyerId, orderId);
    return { data: result };
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
