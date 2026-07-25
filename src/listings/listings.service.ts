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
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import * as Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { CreateListingDto, UpdateListingDto } from './dto/listing.dto';
import { FounderService } from '../founder/founder.service';
import { SUBMITTED_LISTING_STATUSES } from '../founder/founder.constants';
import { listingPublishBlockers } from './listing-publish-rules';
import {
  isInstructionRow,
  validateImportRow,
  mapImportRow,
  TEMPLATE_COLUMNS,
  CATEGORY_SLUGS,
  CONDITION_VALUES,
} from './import-rules';

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
    private readonly eventEmitter: EventEmitter2,
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
      antiSniper,
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
          // anti-sniper vem do wizard; default true quando o campo é omitido.
          antiSniper: antiSniper ?? true,
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

    // ── Quando a edição devolve o anúncio para a fila ──
    //
    // (a) REPROVADO: sem isto vira beco sem saída — `publish` recusava 'rejected',
    //     o front não mostrava o botão e a fila do admin não busca esse status.
    //     O vendedor corrigiria para sempre sem nunca voltar à moderação.
    //
    // (b) ATIVO com campo MODERÁVEL alterado: fecha o furo de aprovar um anúncio
    //     limpo e trocar o conteúdo depois. Só os campos que a equipe realmente
    //     avalia derrubam — preço, SKU e frete não tiram o anúncio do ar, senão
    //     corrigir um centavo custaria uma reanálise e uma venda perdida.
    const camposModeraveis = [
      'title',
      'description',
      'images',
      'categoryId',
    ] as const;
    const mexeuEmModeravel = camposModeraveis.some(
      (campo) =>
        dto[campo] !== undefined && dto[campo] !== (listing as any)[campo],
    );

    const voltouParaFila =
      listing.status === 'rejected' ||
      (listing.status === 'active' && mexeuEmModeravel);

    await this.db
      .update(schema.listings)
      .set({
        ...dto,
        ...(voltouParaFila ? { status: 'pending_review' } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.listings.id, id));

    this.logger.log(
      `[update] Anúncio atualizado: ${id}` +
        (voltouParaFila
          ? ` (${listing.status} → pending_review, de volta à fila)`
          : ''),
    );

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

  async updateStatus(
    id: string,
    status: string,
    opts?: { reason?: string | null; moderatorId?: string },
  ): Promise<ListingRecord> {
    const listing = await this.findById(id); // garante existência

    // ── Peneira de publicação ──
    // Roda ao ENTRAR NA FILA (draft/rejected → pending_review) e ao IR AO AR
    // (→ active). Na fila é onde ela mais serve: barra o anúncio incompleto
    // antes de custar um ciclo de moderação. Na ativação continua valendo como
    // rede — o admin não deve conseguir aprovar um anúncio sem frete.
    const entrandoNaFila =
      status === 'pending_review' &&
      (listing.status === 'draft' || listing.status === 'rejected');
    const indoAoAr =
      status === 'active' &&
      ['draft', 'pending_review', 'rejected'].includes(listing.status);

    if (entrandoNaFila || indoAoAr) {
      const missing = await this.getPublishBlockers(listing);
      if (missing.length > 0) {
        throw new BadRequestException({
          message: `Não é possível publicar. Faltam: ${missing.join('; ')}.`,
          missing,
        });
      }
    }

    const now = new Date();
    // Auditoria de moderação: quando o admin passa `moderatorId`, grava quem/quando.
    // Motivo: persistido quando fornecido (reprovação); ao APROVAR (→ active),
    // limpa o motivo antigo para não sobrar razão obsoleta.
    const setFields: Partial<typeof schema.listings.$inferInsert> = {
      status,
      updatedAt: now,
    };
    if (opts?.moderatorId) {
      setFields.moderatedBy = opts.moderatorId;
      setFields.moderatedAt = now;
    }
    if (opts?.reason !== undefined) {
      setFields.rejectionReason = opts.reason || null;
    } else if (status === 'active') {
      setFields.rejectionReason = null;
    }

    await this.db
      .update(schema.listings)
      .set(setFields)
      .where(eq(schema.listings.id, id));

    this.logger.log(`[updateStatus] Anúncio ${id} → status: ${status}`);

    // Auto-inicia o leilão quando o admin ativa um anúncio de leilão ainda parado.
    if (status === 'active' && listing.type === 'auction') {
      await this.startAuctionClockIfPending(id);
    }

    // ── E-mail de moderação (aprovado / reprovado) ──
    // Só quando a mudança veio de uma AÇÃO DE ADMIN (`moderatorId` presente).
    // Publicação feita pelo próprio vendedor também chega aqui com 'active',
    // mas avisar alguém do que ele mesmo acabou de fazer seria ruído.
    if (opts?.moderatorId) {
      const moderationEmail =
        status === 'active'
          ? 'listing-approved'
          : ['rejected', 'cancelled'].includes(status)
            ? 'listing-rejected'
            : null;

      if (moderationEmail) {
        this.eventEmitter.emit('listing.moderated', {
          template: moderationEmail,
          listingId: id,
          sellerId: listing.sellerId,
          listingTitle: listing.title,
          reason: setFields.rejectionReason ?? null,
        });
      }
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

  // ── Peneira: requisitos que faltam para publicar ─────────────────────────

  /** Lista (legível) de requisitos faltantes p/ publicar; vazio = pode ir ao ar. */
  async getPublishBlockers(listing: ListingRecord): Promise<string[]> {
    let startingBidInCents: number | null | undefined;
    let reservePriceInCents: number | null | undefined;
    if (listing.type === 'auction') {
      const [auction] = await this.db
        .select({
          startingBidInCents: schema.auctions.startingBidInCents,
          reservePriceInCents: schema.auctions.reservePriceInCents,
        })
        .from(schema.auctions)
        .where(eq(schema.auctions.listingId, listing.id))
        .limit(1);
      startingBidInCents = auction?.startingBidInCents;
      reservePriceInCents = auction?.reservePriceInCents;
    }

    // Slug da categoria → campos obrigatórios específicos (marca/escala/jogo…).
    let categorySlug: string | null = null;
    if (listing.categoryId) {
      const [cat] = await this.db
        .select({ slug: schema.categories.slug })
        .from(schema.categories)
        .where(eq(schema.categories.id, listing.categoryId))
        .limit(1);
      categorySlug = cat?.slug ?? null;
    }

    return listingPublishBlockers(listing, startingBidInCents, {
      reservePriceInCents,
      categorySlug,
    });
  }

  // ── Enviar para análise (vendedor) — draft → pending_review ──────────────

  /**
   * O vendedor ENVIA o anúncio para a fila de moderação. Não vai ao ar aqui:
   * `active` só é alcançável pelo admin (`PATCH /api/admin/listings/:id/status`),
   * que é a decisão do dono — a moderação é sempre quem ativa.
   *
   * Passa pela peneira ANTES de entrar na fila: é melhor o vendedor descobrir
   * na hora que faltam 3 fotos do que a equipe gastar um ciclo reprovando isso.
   *
   * Exceção: `paused` volta direto para `active`. O anúncio já foi aprovado uma
   * vez e pausar é decisão do vendedor, não da moderação — mandar para a fila
   * de novo seria retrabalho puro.
   */
  async publish(id: string, sellerId: string): Promise<ListingRecord> {
    const listing = await this.findById(id);

    if (listing.sellerId !== sellerId) {
      throw new ForbiddenException(
        'Você não tem permissão para enviar este anúncio.',
      );
    }
    if (listing.status === 'pending_review') {
      throw new BadRequestException(
        'Este anúncio já está na fila de análise.',
      );
    }
    if (!['draft', 'rejected', 'paused'].includes(listing.status)) {
      throw new BadRequestException(
        `Anúncio não pode ser enviado a partir do status '${listing.status}'.`,
      );
    }

    // Reativação de anúncio pausado: valida aqui porque não passa pela fila.
    if (listing.status === 'paused') {
      const missing = await this.getPublishBlockers(listing);
      if (missing.length > 0) {
        throw new BadRequestException({
          message: `Não é possível reativar. Faltam: ${missing.join('; ')}.`,
          missing,
        });
      }
      return this.updateStatus(id, 'active');
    }

    return this.updateStatus(id, 'pending_review');
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

      // Slug → id da categoria. Antes o `category` da planilha era descartado e
      // o anúncio nascia sem categoria, sem aparecer na busca nem na vitrine.
      const categoryRows = await this.db
        .select({ id: schema.categories.id, slug: schema.categories.slug })
        .from(schema.categories);
      const categoryIdBySlug = new Map(
        categoryRows.map((c) => [c.slug, c.id]),
      );

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNumber = i + 2; // Cabeçalho é 1

        // As duas linhas de instrução do modelo não são dados.
        if (isInstructionRow(row)) continue;

        try {
          // Mesma validação do front — protege quem chama a API direto.
          const rowErrors = validateImportRow(row, rowNumber);
          if (rowErrors.length > 0) {
            throw new Error(
              rowErrors.map((e) => `${e.campo}: ${e.mensagem}`).join('; '),
            );
          }

          const mapped = mapImportRow(row);
          const categoryId = categoryIdBySlug.get(mapped.categorySlug);
          if (!categoryId) {
            throw new Error(
              `category: categoria "${mapped.categorySlug}" não existe no banco`,
            );
          }

          // Importado entra na fila de moderação, nunca direto no ar.
          await this.db.insert(schema.listings).values({
            id: crypto.randomUUID(),
            sellerId,
            categoryId,
            title: mapped.title,
            description: mapped.description,
            condition: mapped.condition,
            type: 'direct',
            priceInCents: mapped.priceInCents,
            images: mapped.images,
            weightGrams: mapped.weightGrams,
            widthCm: mapped.widthCm,
            heightCm: mapped.heightCm,
            lengthCm: mapped.lengthCm,
            brand: mapped.brand,
            scale: mapped.scale,
            line: mapped.line,
            year: mapped.year,
            edition: mapped.edition,
            sku: mapped.sku,
            attributes: mapped.attributes,
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

  /**
   * CSV modelo. O antigo mandava `category_slug` vazio, `stock_quantity` e o
   * vocabulário abandonado de condição (`usado`) — foi o que fez um vendedor
   * subir centenas de anúncios incompletos. Agora espelha as colunas reais.
   */
  async getImportTemplate() {
    const csvHeader = `${TEMPLATE_COLUMNS.join(',')}\n`;
    const exemplo: Record<string, string> = {
      title: 'Hot Wheels Nissan Skyline GT-R R34 Premium',
      category: CATEGORY_SLUGS[0],
      condition: CONDITION_VALUES[0],
      description: 'Lacrado, nunca aberto. Peça guardada em caixa desde 2023.',
      price: '149.90',
      images:
        'https://site.com/1.jpg,https://site.com/2.jpg,https://site.com/3.jpg',
      brand: 'Hot Wheels',
      scale: '1:64',
      weight_grams: '150',
      width_cm: '15',
      height_cm: '10',
      length_cm: '5',
      sku: 'HW-R34-001',
      year: '2023',
    };
    const csvExample =
      TEMPLATE_COLUMNS.map((c) => {
        const v = exemplo[c] ?? '';
        return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(',') + '\n';
    return {
      templateUrl: 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvHeader + csvExample)
    };
  }
}
