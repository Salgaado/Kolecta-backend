import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, desc, and, getTableColumns, like, sql } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import * as Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { CreateListingDto, UpdateListingDto } from './dto/listing.dto';
import { FounderService } from '../founder/founder.service';
import { SUBMITTED_LISTING_STATUSES } from '../founder/founder.constants';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

// DTOs movidos para ./dto/listing.dto.ts (classes, p/ o ValidationPipe global).
// Re-exportados para manter compatibilidade com importadores existentes.
export { CreateListingDto, UpdateListingDto };

export type ListingRecord = typeof schema.listings.$inferSelect & {
  sellerName?: string | null;
};

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly founderService: FounderService,
  ) {}

  // ── Buscar por ID ────────────────────────────────────────────────────────

  async findById(id: string): Promise<ListingRecord> {
    const result = await this.db
      .select({
        ...getTableColumns(schema.listings),
        sellerName: schema.users.name,
      })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .where(eq(schema.listings.id, id))
      .limit(1);

    if (!result.length) {
      throw new NotFoundException(`Anúncio ${id} não encontrado.`);
    }

    return result[0];
  }

  // ── Listar anúncios públicos ativos ──────────────────────────────────────

  async findAll(limit = 20, offset = 0, q?: string): Promise<ListingRecord[]> {
    let query = this.db
      .select({
        ...getTableColumns(schema.listings),
        sellerName: schema.users.name,
      })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .where(eq(schema.listings.status, 'active'))
      .$dynamic();

    if (q) {
      query = query.where(
        and(
          eq(schema.listings.status, 'active'),
          like(schema.listings.title, `%${q}%`),
        ),
      );
    }

    // Destaques ativos primeiro (featuredUntil no futuro), depois mais recentes.
    const nowSeconds = Math.floor(Date.now() / 1000);
    return query
      .orderBy(
        sql`CASE WHEN ${schema.listings.featuredUntil} > ${nowSeconds} THEN 0 ELSE 1 END`,
        desc(schema.listings.createdAt),
      )
      .limit(limit)
      .offset(offset);
  }

  // ── Listar anúncios para Administração (filtra por status) ───────────────

  async findAllAdmin(
    status?: string,
    limit = 50,
    offset = 0,
  ): Promise<ListingRecord[]> {
    let query = this.db
      .select({
        ...getTableColumns(schema.listings),
        sellerName: schema.users.name,
      })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .$dynamic();

    if (status) {
      query = query.where(eq(schema.listings.status, status));
    }

    return query
      .orderBy(desc(schema.listings.createdAt))
      .limit(limit)
      .offset(offset);
  }

  // ── Listar anúncios do vendedor (todas as status) ────────────────────────

  async findBySeller(sellerId: string): Promise<ListingRecord[]> {
    return this.db
      .select({
        ...getTableColumns(schema.listings),
        sellerName: schema.users.name,
      })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .where(eq(schema.listings.sellerId, sellerId))
      .orderBy(desc(schema.listings.createdAt));
  }

  // ── Criar anúncio ────────────────────────────────────────────────────────

  /**
   * Gate de KYC: só permite publicar se o recebedor do vendedor estiver apto
   * (`sellerProfiles.canReceive`). Atrás da flag `ENFORCE_SELLER_KYC` (default
   * OFF) porque hoje nenhum vendedor concluiu KYC (recebedores bloqueados no
   * suporte Pagar.me) — ligar a flag só quando o fluxo de recebedores estiver ativo.
   */
  private async assertCanSell(sellerId: string): Promise<void> {
    if (process.env.ENFORCE_SELLER_KYC !== 'true') return;

    const [profile] = await this.db
      .select({ canReceive: schema.sellerProfiles.canReceive })
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, sellerId))
      .limit(1);

    if (!profile?.canReceive) {
      throw new ForbiddenException(
        'Conclua a verificação de identidade (KYC) para publicar anúncios.',
      );
    }
  }

  /**
   * Exige que o vendedor tenha um endereço cadastrado na plataforma (tabela
   * `addresses`, a mesma de "Minha Conta → Endereços"). Esse endereço é usado
   * como ORIGEM do frete na cotação/etiqueta (ver ShippingService.resolveOriginCep),
   * então sem ele não dá pra cotar envio de verdade.
   */
  private async assertHasOriginAddress(sellerId: string): Promise<void> {
    const [addr] = await this.db
      .select({ id: schema.addresses.id })
      .from(schema.addresses)
      .where(eq(schema.addresses.userId, sellerId))
      .limit(1);

    if (!addr) {
      throw new BadRequestException(
        'Cadastre um endereço em "Minha Conta → Endereços" antes de anunciar. ' +
          'Ele será usado como origem do frete.',
      );
    }
  }

  async create(
    sellerId: string,
    dto: CreateListingDto,
  ): Promise<ListingRecord> {
    await this.assertCanSell(sellerId);
    await this.assertHasOriginAddress(sellerId);

    const id = crypto.randomUUID();

    // Separa a config de leilão dos campos do listing (não são colunas de listings).
    const {
      startingBidInCents,
      minIncrementInCents,
      reservePriceInCents,
      durationHours,
      ...listingData
    } = dto;

    if (dto.type === 'auction' && startingBidInCents == null) {
      throw new BadRequestException(
        'Leilão exige um lance inicial (startingBidInCents).',
      );
    }

    await this.db.transaction(async (tx) => {
      await tx.insert(schema.listings).values({
        id,
        sellerId,
        ...listingData,
        status: 'draft',
      });

      if (dto.type === 'auction') {
        // endsAt omitido = null → leilão "parado"; o relógio começa na ativação
        // pelo admin (ver updateStatus → startAuctionClockIfPending).
        await tx.insert(schema.auctions).values({
          listingId: id,
          startingBidInCents: startingBidInCents!,
          minIncrementInCents: minIncrementInCents ?? 1000,
          reservePriceInCents: reservePriceInCents ?? null,
          durationHours: durationHours ?? 48,
          status: 'active',
        });
      }
    });

    this.logger.log(
      `[create] Anúncio criado: ${id} por sellerId: ${sellerId}${dto.type === 'auction' ? ' (+ leilão parado)' : ''}`,
    );

    return this.findById(id);
  }

  // ── Atualizar anúncio ────────────────────────────────────────────────────

  async update(
    id: string,
    sellerId: string,
    dto: UpdateListingDto,
  ): Promise<ListingRecord> {
    const listing = await this.findById(id);

    // Apenas o próprio vendedor pode editar
    if (listing.sellerId !== sellerId) {
      throw new ForbiddenException(
        'Você não tem permissão para editar este anúncio.',
      );
    }

    await this.db
      .update(schema.listings)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(schema.listings.id, id));

    this.logger.log(`[update] Anúncio atualizado: ${id}`);

    return this.findById(id);
  }

  // ── Deletar anúncio ──────────────────────────────────────────────────────

  async remove(id: string, sellerId: string): Promise<void> {
    const listing = await this.findById(id);

    // Apenas o próprio vendedor pode deletar
    if (listing.sellerId !== sellerId) {
      throw new ForbiddenException(
        'Você não tem permissão para remover este anúncio.',
      );
    }

    await this.db.delete(schema.listings).where(eq(schema.listings.id, id));

    this.logger.log(`[remove] Anúncio removido: ${id}`);
  }

  // ── Atualizar status (admin/sistema) ─────────────────────────────────────

  async updateStatus(id: string, status: string): Promise<ListingRecord> {
    const listing = await this.findById(id); // garante existência

    await this.db
      .update(schema.listings)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.listings.id, id));

    this.logger.log(`[updateStatus] Anúncio ${id} → status: ${status}`);

    // Auto-inicia o leilão quando o admin ativa um anúncio de leilão ainda parado.
    if (status === 'active' && listing.type === 'auction') {
      await this.startAuctionClockIfPending(id);
    }

    // Anúncio entrou em estado "enviado" → reavalia qualificação de fundador do
    // vendedor (idempotente). Não pode quebrar a atualização de status.
    if ((SUBMITTED_LISTING_STATUSES as readonly string[]).includes(status)) {
      this.founderService
        .evaluate(listing.sellerId)
        .catch((err) =>
          this.logger.error(
            `[updateStatus] Falha ao reavaliar fundador de ${listing.sellerId}: ${err.message}`,
          ),
        );
    }

    return this.findById(id);
  }

  /**
   * Inicia o cronômetro do leilão vinculado (endsAt = agora + durationHours) na
   * primeira vez que o anúncio vira `active`. Idempotente: se `endsAt` já estiver
   * setado (leilão já iniciado), não faz nada.
   */
  private async startAuctionClockIfPending(listingId: string): Promise<void> {
    const [auction] = await this.db
      .select({
        id: schema.auctions.id,
        endsAt: schema.auctions.endsAt,
        durationHours: schema.auctions.durationHours,
      })
      .from(schema.auctions)
      .where(eq(schema.auctions.listingId, listingId))
      .limit(1);

    if (!auction || auction.endsAt) return; // sem leilão ou já iniciado

    const endsAt = new Date(
      Date.now() + (auction.durationHours ?? 48) * 60 * 60 * 1000,
    );

    await this.db
      .update(schema.auctions)
      .set({ endsAt, status: 'active', updatedAt: new Date() })
      .where(eq(schema.auctions.id, auction.id));

    this.logger.log(
      `[updateStatus] Leilão do anúncio ${listingId} iniciado — termina em ${endsAt.toISOString()}`,
    );
  }

  // ── Toggle pause (vendedor) ───────────────────────────────────────────────

  async togglePause(
    id: string,
    sellerId: string,
  ): Promise<ListingRecord> {
    const listing = await this.findById(id);

    if (listing.sellerId !== sellerId) {
      throw new ForbiddenException(
        'Você não tem permissão para alterar este anúncio.',
      );
    }

    const newStatus = listing.status === 'paused' ? 'active' : 'paused';

    await this.db
      .update(schema.listings)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(schema.listings.id, id));

    this.logger.log(`[togglePause] Anúncio ${id}: ${listing.status} → ${newStatus}`);

    return this.findById(id);
  }

  // ── Importação em lote (CSV/XLSX) ────────────────────────────────────────

  async startImportJob(sellerId: string, file: Express.Multer.File) {
    // Mesmo gate do fluxo unitário: sem endereço de origem, não dá pra cotar frete.
    await this.assertHasOriginAddress(sellerId);

    const jobId = crypto.randomUUID();

    // Cria o registro no banco informando status 'processing'
    await this.db.insert(schema.importJobs).values({
      id: jobId,
      userId: sellerId,
      status: 'processing',
    });

    // Inicia o processamento pseudo-background
    // Importante: No NestJS, para não bloquear o response, não usamos await aqui.
    this.processImportFile(jobId, sellerId, file).catch(err => {
      this.logger.error(`Erro ao processar job ${jobId}`, err);
    });

    return { jobId, status: 'processing', message: 'Importação iniciada' };
  }

  private parseFileToRows(file: Express.Multer.File): any[] {
    const isXlsx =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname?.endsWith('.xlsx') ||
      file.originalname?.endsWith('.xls');

    if (isXlsx) {
      const workbook = XLSX.read(file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      return XLSX.utils.sheet_to_json(sheet, { defval: '' });
    }

    const result = Papa.parse(file.buffer.toString('utf-8'), {
      header: true,
      skipEmptyLines: true,
    });
    return result.data as any[];
  }

  private async processImportFile(jobId: string, sellerId: string, file: Express.Multer.File) {
    try {
      const rows = this.parseFileToRows(file);
      let processed = 0;
      let failed = 0;
      const errors = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNumber = i + 2; // Cabeçalho é 1

        try {
          if (!row.title) throw new Error('Título é obrigatório');
          if (!row.price) throw new Error('Preço é obrigatório');
          if (!row.condition) throw new Error('Condição é obrigatória');

          const priceInCents = Math.round(parseFloat(row.price) * 100);
          if (isNaN(priceInCents)) throw new Error('Preço inválido');

          // Validação da condição (aceitar os definidos no DB)
          const validConditions = ['lacrado', 'novo', 'mint', 'usado', 'novo-lacrado', 'novo-sem-caixa', 'usado-conservado', 'usado-com-marcas'];
          const condition = row.condition.toLowerCase();
          if (!validConditions.includes(condition)) {
            throw new Error(`Condição inválida. Esperado: ${validConditions.join(', ')}`);
          }

          // O schema pede status draft | pending_review | active | sold | cancelled
          // O SKILL.md pede que importados entrem como pending_review ou pending. O schema tem pending_review.
          await this.db.insert(schema.listings).values({
            id: crypto.randomUUID(),
            sellerId,
            title: row.title,
            description: row.description || '',
            condition: condition,
            type: 'direct',
            priceInCents,
            images: row.images ? JSON.stringify(row.images.split(',')) : null,
            status: 'pending_review',
          });

          processed++;
        } catch (err: any) {
          failed++;
          errors.push({ row: rowNumber, error: err.message });
        }
      }

      const finalStatus = failed > 0 ? (processed > 0 ? 'completed_with_errors' : 'failed') : 'completed';

      await this.db.update(schema.importJobs).set({
        status: finalStatus,
        totalRows: rows.length,
        processedRows: processed,
        failedRows: failed,
        errors: JSON.stringify(errors),
        updatedAt: new Date(),
      }).where(eq(schema.importJobs.id, jobId));

    } catch (globalError: any) {
      await this.db.update(schema.importJobs).set({
        status: 'failed',
        errors: JSON.stringify([{ row: 0, error: `Erro fatal no processamento: ${globalError.message}` }]),
        updatedAt: new Date(),
      }).where(eq(schema.importJobs.id, jobId));
    }
  }

  async getImportJob(sellerId: string, jobId: string) {
    const [job] = await this.db.select()
      .from(schema.importJobs)
      .where(
        and(
          eq(schema.importJobs.id, jobId),
          eq(schema.importJobs.userId, sellerId)
        )
      ).limit(1);

    if (!job) throw new NotFoundException('Job não encontrado');

    return {
      ...job,
      errors: job.errors ? JSON.parse(job.errors) : [],
    };
  }

  async getImportTemplate() {
    const csvHeader = 'title,description,price,category_slug,condition,images,stock_quantity\n';
    const csvExample = 'Action Figure Batman,"Boneco muito conservado",150.00,,usado,"http://img1.com,http://img2.com",1\n';
    return {
      templateUrl: 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvHeader + csvExample)
    };
  }
}
