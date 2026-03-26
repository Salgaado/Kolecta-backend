import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { ListingsService } from './listings.service';
import type { CreateListingDto, UpdateListingDto } from './listings.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/listings')
export class ListingsController {
  private readonly logger = new Logger(ListingsController.name);

  constructor(private readonly listingsService: ListingsService) {}

  // ── GET /api/listings — Público: lista anúncios ativos ──────────────────

  @Get()
  async findAll(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const listings = await this.listingsService.findAll(
      limit ? Number(limit) : 20,
      offset ? Number(offset) : 0,
    );
    return { data: listings };
  }

  // ── GET /api/listings/:id — Público: detalhe de um anúncio ──────────────

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const listing = await this.listingsService.findById(id);
    return { data: listing };
  }

  // ── GET /api/listings/seller/me — Vendedor: meus anúncios ───────────────

  @Get('seller/me')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  async findMine(@Req() req: Request) {
    const sellerId = (req as any).auth.userId as string;
    const listings = await this.listingsService.findBySeller(sellerId);
    return { data: listings };
  }

  // ── POST /api/listings — Vendedor: criar anúncio ────────────────────────

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: Request, @Body() dto: CreateListingDto) {
    const sellerId = (req as any).auth.userId as string;
    const listing = await this.listingsService.create(sellerId, dto);
    return { data: listing };
  }

  // ── PATCH /api/listings/:id — Vendedor: editar anúncio ──────────────────

  @Patch(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  async update(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() dto: UpdateListingDto,
  ) {
    const sellerId = (req as any).auth.userId as string;
    const listing = await this.listingsService.update(id, sellerId, dto);
    return { data: listing };
  }

  // ── PATCH /api/listings/:id/status — Admin: mudar status ────────────────

  @Patch(':id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  async updateStatus(@Param('id') id: string, @Body('status') status: string) {
    const listing = await this.listingsService.updateStatus(id, status);
    return { data: listing };
  }

  // ── DELETE /api/listings/:id — Vendedor: remover anúncio ────────────────

  @Delete(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @Req() req: Request) {
    const sellerId = (req as any).auth.userId as string;
    await this.listingsService.remove(id, sellerId);
  }
}
