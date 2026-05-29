import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, desc, and, getTableColumns, like } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import * as Papa from 'papaparse';
import * as XLSX from 'xlsx';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export type CreateListingDto = {
  title: string;
  description?: string;
  categoryId?: string;
  brand?: string;
  line?: string;
  scale?: string;
  year?: string;
  edition?: string;
  condition: string; // lacrado | novo | mint | usado
  type: 'direct' | 'auction';
  priceInCents?: number;
  images?: string; // JSON array stringificado
};

export type UpdateListingDto = Partial<Omit<CreateListingDto, 'type'>>;

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

    return query
      .orderBy(desc(schema.listings.createdAt))
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

  async create(
    sellerId: string,
    dto: CreateListingDto,
  ): Promise<ListingRecord> {
    const id = crypto.randomUUID();

    await this.db.insert(schema.listings).values({
      id,
      sellerId,
      ...dto,
      status: 'draft',
    });

    this.logger.log(`[create] Anúncio criado: ${id} por sellerId: ${sellerId}`);

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
    await this.findById(id); // garante existência

    await this.db
      .update(schema.listings)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.listings.id, id));

    this.logger.log(`[updateStatus] Anúncio ${id} → status: ${status}`);

    return this.findById(id);
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
