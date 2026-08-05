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
import {
  CreateListingDto,
  UpdateListingDto,
  ReorderListingsDto,
} from './dto/listing.dto';
import { ColocarEmLeilaoDto } from './dto/colocar-em-leilao.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

/** Query string é sempre texto: devolve inteiro ou undefined (nunca NaN). */
function inteiro(valor?: string): number | undefined {
  if (valor == null || valor.trim() === '') return undefined;
  const n = Number(valor);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** "novo,lacrado" → ['novo','lacrado']. undefined quando não veio nada. */
function lista(valor?: string): string[] | undefined {
  const itens = (valor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return itens.length ? itens : undefined;
}

@Controller('api/listings')
export class ListingsController {
  private readonly logger = new Logger(ListingsController.name);

  constructor(private readonly listingsService: ListingsService) {}

  // ── GET /api/listings — Público: lista anúncios ativos ──────────────────

  /**
   * Vitrine, categoria e busca — tudo filtrado e paginado NO BANCO.
   *
   * `limit`/`offset` continuam funcionando como antes (o front atual manda os
   * dois), e `page` é o atalho equivalente. `total`/`totalPages` vêm no `meta`,
   * no mesmo formato que o endpoint do vendedor já usa, para o front parar de
   * baixar o catálogo inteiro só para saber quantos anúncios existem.
   */
  @Get()
  async findAll(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('category') category?: string,
    @Query('condition') condition?: string,
    @Query('type') type?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
  ) {
    // Teto de 500: é o que o front pede hoje quando baixa o catálogo, e sem
    // limite um `limit=100000` derruba a resposta inteira.
    const take = clamp(inteiro(limit) ?? 20, 1, 500);
    const skip =
      inteiro(offset) ?? Math.max(0, ((inteiro(page) ?? 1) - 1) * take);

    const { items, total } = await this.listingsService.findAll({
      limit: take,
      offset: skip,
      q: q?.trim() || undefined,
      // `category` e `categoryId` são o mesmo filtro: o serviço aceita id ou
      // slug, e assim o front usa o que tiver em mãos na tela.
      categoria: (categoryId || category)?.trim() || undefined,
      // Aceita lista: "novo,lacrado" — a tela de busca marca mais de uma.
      condicoes: lista(condition),
      tipo: type?.trim() || undefined,
      precoMin: inteiro(minPrice),
      precoMax: inteiro(maxPrice),
    });

    return {
      data: items,
      meta: {
        total,
        limit: take,
        offset: skip,
        page: Math.floor(skip / take) + 1,
        totalPages: Math.max(1, Math.ceil(total / take)),
        hasMore: skip + items.length < total,
      },
    };
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

  // ── PATCH /api/listings/reorder — Vendedor: ordem da vitrine da loja ─────
  //
  // Rota ESTÁTICA declarada antes de `@Patch(':id')` de propósito: senão o
  // "reorder" cairia como se fosse um id de anúncio.
  @Patch('reorder')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async reorder(@Req() req: Request, @Body() dto: ReorderListingsDto) {
    const sellerId = (req as any).auth.userId as string;
    await this.listingsService.reorder(sellerId, dto.ids);
    return { data: { ok: true } };
  }

  // ── POST /api/listings/import — Importar lote de anúncios ────────────────

  @Post('import')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.ACCEPTED)
  async importListings(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const sellerId = (req as any).auth.userId as string;
    if (!file)
      throw new HttpException('Arquivo não fornecido', HttpStatus.BAD_REQUEST);
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

  // ── POST /api/listings/:id/colocar-em-leilao ─────────────────────────────
  //
  // Reaproveita o anúncio que o vendedor já montou. Estoque 1 converte o
  // próprio; estoque maior duplica e tira uma unidade do original, para ele
  // seguir vendendo o resto na compra direta sem risco de vender a mesma peça
  // duas vezes.

  @Post(':id/colocar-em-leilao')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async colocarEmLeilao(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() dto: ColocarEmLeilaoDto,
  ) {
    const sellerId = (req as any).auth.userId as string;
    return { data: await this.listingsService.colocarEmLeilao(id, sellerId, dto) };
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
