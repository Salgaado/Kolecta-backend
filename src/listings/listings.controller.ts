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
  UseInterceptors,
  UploadedFile,
  HttpException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { ListingsService } from './listings.service';
import { CreateListingDto, UpdateListingDto } from './dto/listing.dto';
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
    @Query('q') q?: string,
  ) {
    const listings = await this.listingsService.findAll(
      limit ? Number(limit) : 20,
      offset ? Number(offset) : 0,
      q,
    );
    return { data: listings };
  }

  // ── GET /api/listings/admin — Admin: dashboard queue ─────────────────────

  @Get('admin')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  async findAllAdmin(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const listings = await this.listingsService.findAllAdmin(
      status,
      limit ? Number(limit) : 50,
      offset ? Number(offset) : 0,
    );
    return { data: listings };
  }

  // ── GET /api/listings/my — Meus anúncios ────────────────────────────────

  @Get('my')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async findMine(@Req() req: Request) {
    const sellerId = (req as any).auth.userId as string;
    const listings = await this.listingsService.findBySeller(sellerId);
    return { data: listings };
  }

  // ── POST /api/listings/import — Importar lote de anúncios ────────────────

  @Post('import')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.ACCEPTED)
  async importListings(@Req() req: Request, @UploadedFile() file: Express.Multer.File) {
    const sellerId = (req as any).auth.userId as string;
    if (!file) throw new HttpException('Arquivo não fornecido', HttpStatus.BAD_REQUEST);
    const job = await this.listingsService.startImportJob(sellerId, file);
    return { data: job };
  }

  // ── GET /api/listings/import/template — Template de importação ──────────

  @Get('import/template')
  async getImportTemplate() {
    return this.listingsService.getImportTemplate();
  }

  // ── GET /api/listings/import/:jobId — Status do lote de importação ──────

  @Get('import/:jobId')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async getImportJob(@Req() req: Request, @Param('jobId') jobId: string) {
    const sellerId = (req as any).auth.userId as string;
    const job = await this.listingsService.getImportJob(sellerId, jobId);
    return { data: job };
  }

  // ── GET /api/listings/:id — Público: detalhe de um anúncio ──────────────

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const listing = await this.listingsService.findById(id);
    return { data: listing };
  }

  // ── POST /api/listings — Criar anúncio ──────────────────────────────────

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: Request, @Body() dto: CreateListingDto) {
    const sellerId = (req as any).auth.userId as string;
    const listing = await this.listingsService.create(sellerId, dto);
    return { data: listing };
  }

  // ── PATCH /api/listings/:id — Editar anúncio ───────────────────────────

  @Patch(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async update(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() dto: UpdateListingDto,
  ) {
    const sellerId = (req as any).auth.userId as string;
    const listing = await this.listingsService.update(id, sellerId, dto);
    return { data: listing };
  }

  // ── POST /api/listings/:id/publish — Vendedor: publicar (passa na peneira) ──

  @Post(':id/publish')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async publish(@Param('id') id: string, @Req() req: Request) {
    const sellerId = (req as any).auth.userId as string;
    const listing = await this.listingsService.publish(id, sellerId);
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

  // ── PATCH /api/listings/:id/toggle-pause — Vendedor: pausar/reativar ────

  @Patch(':id/toggle-pause')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async togglePause(@Param('id') id: string, @Req() req: Request) {
    const sellerId = (req as any).auth.userId as string;
    const listing = await this.listingsService.togglePause(id, sellerId);
    return { data: listing };
  }

  // ── DELETE /api/listings/:id — Remover anúncio ─────────────────────────

  @Delete(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @Req() req: Request) {
    const sellerId = (req as any).auth.userId as string;
    await this.listingsService.remove(id, sellerId);
  }
}
