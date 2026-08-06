import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import {
  eq,
  desc,
  and,
  inArray,
  getTableColumns,
  sql,
  type SQL,
} from 'drizzle-orm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import * as Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { CreateListingDto, UpdateListingDto } from './dto/listing.dto';
import { FounderService } from '../founder/founder.service';
import { SUBMITTED_LISTING_STATUSES } from '../founder/founder.constants';
import { alvoDeBusca, condicaoDeBusca } from '../common/busca-sql';
import { listingPublishBlockers } from './listing-publish-rules';
import {
  decidirAcao,
  copiarCampos,
  normalizarConfig,
  type ConfigLeilao,
} from './colocar-em-leilao';
import { montarPatch } from './completar-em-lote';
import {
  isInstructionRow,
  validateImportRow,
  mapImportRow,
  TEMPLATE_COLUMNS,
  CATEGORY_SLUGS,
  CONDITION_VALUES,
} from './import-rules';

/**
 * Fim sentinela de leilão pausado — o mesmo `LIMBO` de `scripts/pausar-leiloes.ts`.
 *
 * Não é prazo, é marcador: mantém o leilão fora do cron de encerramento, e o
 * front (`lib/leilao.ts`) esconde da vitrine todo fim a mais de um ano daqui.
 * O `endsAt` real é recalculado na retomada, a partir do tempo que faltava.
 */
const FIM_SENTINELA = new Date('2099-01-01T00:00:00Z');

// ─── DTOs ─────────────────────────────────────────────────────────────────────

// DTOs movidos para ./dto/listing.dto.ts (classes, p/ o ValidationPipe global).
// Re-exportados para manter compatibilidade com importadores existentes.
export { CreateListingDto, UpdateListingDto };

export type ListingRecord = typeof schema.listings.$inferSelect & {
  sellerName?: string | null;
};

/** Filtros da vitrine pública. Tudo opcional; ausente = não restringe. */
export interface ListingFilters {
  limit?: number;
  offset?: number;
  /** Termo de busca livre (ignora acento e caixa). */
  q?: string;
  /** Id OU slug da categoria. Inclui as subcategorias dela. */
  categoria?: string;
  /** lacrado | novo | mint | usado — aceita mais de uma. */
  condicoes?: string[];
  /** direct | auction */
  tipo?: string;
  precoMin?: number;
  precoMax?: number;
}

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

  /**
   * Config do leilão para as consultas PÚBLICAS. O lance inicial mora na tabela
   * `auctions`, e as listagens devolviam só as colunas de `listings` — por isso
   * o card mostrava "R$ 0,00" num leilão de R$ 3.100: o dado nunca chegava.
   * `bidsCount` sai por subconsulta para não multiplicar linhas no join.
   */
  /**
   * Nome do vendedor na vitrine: o da LOJA quando existir, senão o pessoal.
   *
   * Quem vende como loja ("Culture TCG", "Safari TCG") cadastra o nome em
   * `seller_profiles.store_name`, mas a vitrine mostrava sempre `users.name` —
   * que para quem entrou só com e-mail e senha é a parte local do endereço.
   * O NULLIF trata string vazia como ausente: nome em branco é o mesmo que não
   * ter nome, e sem ele o COALESCE devolveria '' e o card ficaria sem vendedor.
   */
  private readonly sellerDisplayNameExpr = sql<string | null>`COALESCE(
    NULLIF(TRIM(${schema.sellerProfiles.storeName}), ''),
    NULLIF(TRIM(${schema.users.name}), '')
  )`;

  /**
   * A versão com apelido serve só ao SELECT. No WHERE ela vira a referência
   * `"seller_name"` — que o SQLite aceita no SELECT da vitrine e recusa na
   * consulta de contagem, onde a coluna não é projetada. Por isso a expressão
   * crua acima existe separada: o filtro usa ela, a projeção usa esta.
   */
  private readonly sellerDisplayName = this.sellerDisplayNameExpr.as(
    'seller_name',
  );

  /**
   * Foto do vendedor na vitrine: a da LOJA quando o vendedor subiu uma, senão a
   * que veio do Clerk no cadastro.
   *
   * A API devolvia só `sellerName`, então o selo do vendedor aparecia com as
   * iniciais no card, no perfil da loja e no anúncio — inclusive para quem tinha
   * subido foto, que só a via no próprio painel.
   */
  private readonly sellerAvatar = sql<string | null>`COALESCE(
    NULLIF(TRIM(${schema.sellerProfiles.avatarUrl}), ''),
    NULLIF(TRIM(${schema.users.avatarUrl}), '')
  )`.as('seller_avatar_url');

  private readonly auctionPublicFields = {
    // O lance acontece em /modo-lance/:auctionId, e a vitrine só tinha o id do
    // ANÚNCIO — por isso o "Dar Lance" do card caía em /produto/:id, que não
    // tem lance nenhum. Sem este campo não há como ligar um ao outro no front.
    auctionId: schema.auctions.id,
    startingBidInCents: schema.auctions.startingBidInCents,
    minIncrementInCents: schema.auctions.minIncrementInCents,
    currentBidInCents: schema.auctions.currentBidInCents,
    reservePriceInCents: schema.auctions.reservePriceInCents,
    endsAt: schema.auctions.endsAt,
    auctionStatus: schema.auctions.status,
    // Pausado continua `active` na vitrine — quem some da lista é leilão
    // encerrado. A tela usa isto para mostrar "pausado" no lugar da contagem
    // regressiva, que estaria congelada e pareceria defeito.
    auctionPausedAt: schema.auctions.pausedAt,
    bidsCount: sql<number>`(
      SELECT COUNT(*) FROM ${schema.bids} WHERE ${schema.bids.auctionId} = ${schema.auctions.id}
    )`.as('bids_count'),
  };

  // ── Buscar por ID ────────────────────────────────────────────────────────

  async findById(id: string): Promise<ListingRecord> {
    const result = await this.db
      .select({
        ...getTableColumns(schema.listings),
        sellerName: this.sellerDisplayName,
        // Número do Fundador junto do anúncio, como o nome do vendedor. Sem
        // isto o front buscava o perfil de cada vendedor só para saber se
        // mostra o selo: numa lista de 20 itens, 20 requisições de ~3s.
        sellerFounderNumber: schema.sellerProfiles.founderNumber,
        sellerFounderStatus: schema.sellerProfiles.founderStatus,
        sellerAvatarUrl: this.sellerAvatar,
        ...this.auctionPublicFields,
      })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .leftJoin(
        schema.sellerProfiles,
        eq(schema.sellerProfiles.userId, schema.listings.sellerId),
      )
      .leftJoin(
        schema.auctions,
        eq(schema.auctions.listingId, schema.listings.id),
      )
      .where(eq(schema.listings.id, id))
      .limit(1);

    if (!result.length) {
      throw new NotFoundException(`Anúncio ${id} não encontrado.`);
    }

    return result[0];
  }

  // ── Listar anúncios públicos ativos ──────────────────────────────────────

  /**
   * Preço de comparação do anúncio. Leilão não usa `priceInCents` (fica nulo): o
   * valor que o comprador vê no card é o lance atual, ou o inicial enquanto
   * ninguém lançou. Sem este COALESCE, filtrar por faixa de preço sumiria com
   * todos os leilões.
   */
  private readonly precoComparavel = sql<number>`COALESCE(
    ${schema.listings.priceInCents},
    ${schema.auctions.currentBidInCents},
    ${schema.auctions.startingBidInCents}
  )`;

  /**
   * Anúncio como um texto só, para a busca. Mesmos campos do `alvoDe` do front
   * (`src/lib/busca.ts`), incluindo o nome do vendedor — quem procura "Culture
   * TCG" espera achar a loja.
   */
  private readonly alvoDaBusca = alvoDeBusca([
    schema.listings.title,
    schema.listings.brand,
    schema.listings.line,
    schema.listings.description,
    schema.listings.sku,
    schema.listings.edition,
    this.sellerDisplayNameExpr,
  ]);

  /**
   * Monta o WHERE da vitrine. Fica separado do SELECT porque a contagem total
   * (paginação) precisa exatamente das mesmas condições — duas listas de filtro
   * que se desencontram devolvem um `total` que não bate com as páginas.
   */
  private filtrosPublicos(f: ListingFilters): SQL {
    const cond: SQL[] = [eq(schema.listings.status, 'active')];

    if (f.categoria) {
      // Aceita id ou slug, e traz junto as subcategorias: a página de uma
      // categoria raiz mostra o que está pendurado nela.
      const alvo = sql`(
        SELECT ${schema.categories.id} FROM ${schema.categories}
        WHERE ${schema.categories.id} = ${f.categoria}
           OR ${schema.categories.slug} = ${f.categoria}
      )`;
      cond.push(sql`(
        ${schema.listings.categoryId} IN ${alvo}
        OR ${schema.listings.categoryId} IN (
          SELECT ${schema.categories.id} FROM ${schema.categories}
          WHERE ${schema.categories.parentId} IN ${alvo}
        )
      )`);
    }

    if (f.condicoes?.length) {
      cond.push(inArray(schema.listings.condition, f.condicoes));
    }

    if (f.tipo) cond.push(eq(schema.listings.type, f.tipo));

    if (f.precoMin != null) {
      cond.push(sql`${this.precoComparavel} >= ${f.precoMin}`);
    }
    if (f.precoMax != null) {
      cond.push(sql`${this.precoComparavel} <= ${f.precoMax}`);
    }

    if (f.q) {
      const busca = condicaoDeBusca(this.alvoDaBusca, f.q);
      if (busca) cond.push(busca);
    }

    return and(...cond)!;
  }

  /**
   * Vitrine pública, filtrada e contada NO BANCO.
   *
   * Antes daqui só saíam `limit`/`offset`/`q` (LIKE cru no título), então o front
   * baixava o catálogo inteiro e filtrava categoria, preço, condição e busca no
   * navegador — cada visitante pagando ~1 MB antes de ver a primeira tela.
   * Devolve o total junto para o front paginar de verdade.
   */
  async findAll(
    filtros: ListingFilters = {},
  ): Promise<{ items: ListingRecord[]; total: number }> {
    const limit = filtros.limit ?? 20;
    const offset = filtros.offset ?? 0;
    const where = this.filtrosPublicos(filtros);

    // Destaques ativos primeiro (featuredUntil no futuro), depois mais recentes.
    const nowSeconds = Math.floor(Date.now() / 1000);

    // As duas consultas vão juntas: o custo aqui é a ida ao Turso, e esperar uma
    // para depois pedir a outra dobraria o tempo da tela.
    const [items, [contagem]] = await Promise.all([
      this.db
        .select({
          ...getTableColumns(schema.listings),
          sellerName: this.sellerDisplayName,
          // Número do Fundador junto do anúncio, como o nome do vendedor. Sem
          // isto o front buscava o perfil de cada vendedor só para saber se
          // mostra o selo: numa lista de 20 itens, 20 requisições de ~3s.
          sellerFounderNumber: schema.sellerProfiles.founderNumber,
          sellerFounderStatus: schema.sellerProfiles.founderStatus,
          sellerAvatarUrl: this.sellerAvatar,
          ...this.auctionPublicFields,
        })
        .from(schema.listings)
        .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
        .leftJoin(
          schema.sellerProfiles,
          eq(schema.sellerProfiles.userId, schema.listings.sellerId),
        )
        .leftJoin(
          schema.auctions,
          eq(schema.auctions.listingId, schema.listings.id),
        )
        .where(where)
        .orderBy(
          sql`CASE WHEN ${schema.listings.featuredUntil} > ${nowSeconds} THEN 0 ELSE 1 END`,
          desc(schema.listings.createdAt),
        )
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(schema.listings)
        // Os mesmos joins do SELECT: o filtro de preço e a busca por nome de
        // vendedor dependem das tabelas de leilão e de perfil.
        .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
        .leftJoin(
          schema.sellerProfiles,
          eq(schema.sellerProfiles.userId, schema.listings.sellerId),
        )
        .leftJoin(
          schema.auctions,
          eq(schema.auctions.listingId, schema.listings.id),
        )
        .where(where),
    ]);

    return { items, total: Number(contagem?.total ?? 0) };
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

  // ── Completar em massa ─────────────────────────────────────────────────────

  /**
   * Preenche campos vazios de vários anúncios de uma vez.
   *
   * Nasceu da importação do Bling: o ERP entrega o suficiente para publicar,
   * mas linha, ano e edição ficam vazios, e são eles que alimentam a busca e os
   * filtros da vitrine. O anúncio entra no ar e some da navegação. Editar cem,
   * um por um, não é opção para quem acabou de importar.
   *
   * Só mexe em anúncio DO VENDEDOR, e preenche o que está vazio sem sobrescrever
   * (ver `completar-em-lote.ts`). Anúncio já completo não gasta UPDATE.
   */
  async completarEmLote(
    sellerId: string,
    ids: string[],
    valores: Record<string, string>,
    sobrescrever = false,
  ) {
    const unicos = [...new Set((ids ?? []).filter(Boolean))];
    if (unicos.length === 0) {
      throw new BadRequestException('Escolha pelo menos um anúncio.');
    }
    if (Object.values(valores ?? {}).every((v) => !String(v ?? '').trim())) {
      throw new BadRequestException('Preencha ao menos um campo.');
    }

    const anuncios = await this.db
      .select()
      .from(schema.listings)
      .where(
        and(
          eq(schema.listings.sellerId, sellerId),
          inArray(schema.listings.id, unicos),
        ),
      );

    let alterados = 0;
    for (const anuncio of anuncios) {
      const patch = montarPatch(anuncio as any, valores, sobrescrever);
      if (!patch) continue;

      await this.db
        .update(schema.listings)
        .set({
          ...patch.colunas,
          ...(patch.attributes ? { attributes: patch.attributes } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.listings.id, anuncio.id));
      alterados++;
    }

    this.logger.log(
      `[completarEmLote] ${alterados} de ${anuncios.length} anúncio(s) alterados (vendedor ${sellerId}).`,
    );
    // `encontrados` menor que `pedidos` significa que veio id que não é dele.
    // A tela mostra a diferença em vez de fingir que tudo deu certo.
    return { pedidos: unicos.length, encontrados: anuncios.length, alterados };
  }

  // ── Colocar em leilão ──────────────────────────────────────────────────────

  /**
   * Transforma um anúncio de compra direta em leilão.
   *
   * O vendedor já montou tudo (fotos, descrição, medidas, atributos) e quer
   * leiloar. Refazer isso num anúncio novo é o trabalho que este método existe
   * para evitar. Foi pedido por um cliente.
   *
   * Estoque 1 CONVERTE o próprio anúncio; estoque maior DUPLICA e tira uma
   * unidade do original. A decisão está em `colocar-em-leilao.ts`, com o porquê:
   * duplicar peça única deixaria o vendedor vender o mesmo objeto duas vezes.
   *
   * O resultado volta para `pending_review` nos dois casos, e não é burocracia:
   * o relógio do leilão só começa em `startAuctionClockIfPending`, que roda na
   * aprovação. Leilão criado já ativo ficaria com `endsAt` nulo para sempre,
   * ou seja, um leilão que nunca corre.
   */
  async colocarEmLeilao(
    listingId: string,
    sellerId: string,
    config: ConfigLeilao,
  ) {
    const [anuncio] = await this.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, listingId));

    if (!anuncio) throw new NotFoundException('Anúncio não encontrado.');
    if (anuncio.sellerId !== sellerId) {
      throw new ForbiddenException('Este anúncio não é seu.');
    }
    if (!config?.startingBidInCents || config.startingBidInCents <= 0) {
      throw new BadRequestException('Informe o lance inicial.');
    }

    const pedidos = await this.db
      .select({ status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.listingId, listingId));

    const { acao, motivo } = decidirAcao({
      type: anuncio.type,
      stock: anuncio.stock,
      statusDosPedidos: pedidos.map((p: any) => p.status),
    });
    if (!acao) throw new BadRequestException(motivo!);

    const leilao = normalizarConfig(config);
    let idDoLeilao = listingId;

    await this.db.transaction(async (tx: any) => {
      if (acao === 'duplicar') {
        idDoLeilao = crypto.randomUUID();
        await tx.insert(schema.listings).values({
          ...copiarCampos(anuncio as any),
          id: idDoLeilao,
          sellerId,
          type: 'auction',
          // Leilão é de UMA peça. O preço de compra direta não se aplica.
          priceInCents: null,
          stock: 1,
          status: 'pending_review',
        });
        // A unidade leiloada sai do anúncio direto, senão o vendedor teria 3 na
        // vitrine e 1 no leilão, com 3 peças na prateleira: uma venda a mais do
        // que ele tem.
        await tx
          .update(schema.listings)
          .set({
            stock: Math.max(0, Number(anuncio.stock ?? 1) - 1),
            updatedAt: new Date(),
          })
          .where(eq(schema.listings.id, listingId));
      } else {
        await tx
          .update(schema.listings)
          .set({
            type: 'auction',
            priceInCents: null,
            stock: 1,
            status: 'pending_review',
            updatedAt: new Date(),
          })
          .where(eq(schema.listings.id, listingId));
      }

      // `endsAt` omitido = leilão parado. O relógio começa na aprovação, e lá
      // vale a regra de vendedor sem recebedor nascer pausado.
      await tx.insert(schema.auctions).values({
        listingId: idDoLeilao,
        ...leilao,
        status: 'active',
      });
    });

    this.logger.log(
      `[colocarEmLeilao] ${acao} anúncio ${listingId} -> leilão ${idDoLeilao} (vendedor ${sellerId}).`,
    );
    return { acao, listingId: idDoLeilao, original: listingId };
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

  // ── Reordenar a vitrine da loja ──────────────────────────────────────────
  //
  // O vendedor arrasta os próprios anúncios para a ordem em que quer que
  // apareçam na página dele. `ids` chega na ordem desejada (o primeiro é o
  // topo); cada anúncio recebe `position` = seu índice. O `and(sellerId)`
  // garante que ninguém reordene anúncio de outro: id de terceiro não casa e é
  // simplesmente ignorado, sem erro.
  async reorder(sellerId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const updates = ids.map((id, i) =>
      this.db
        .update(schema.listings)
        .set({ position: i, updatedAt: new Date() })
        .where(
          and(
            eq(schema.listings.id, id),
            eq(schema.listings.sellerId, sellerId),
          ),
        ),
    );
    // Uma ida só ao banco em vez de N: a loja pode ter dezenas de anúncios.
    await this.db.batch(updates as any);
    this.logger.log(
      `[reorder] ${ids.length} anúncios reordenados (vendedor ${sellerId}).`,
    );
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
   *
   * Vendedor sem recebedor apto na Pagar.me: o leilão nasce PAUSADO em vez de ir
   * ao ar. Sem recebedor, `montarSplitOuRecusar` recusa todo lance com "este
   * vendedor ainda não está apto a receber pagamentos" — o leilão ficava visível
   * e indisputável, e quem levava a culpa era a plataforma. Antes disto o único
   * freio era `scripts/pausar-leiloes.ts`, rodado à mão: leilão ativado depois da
   * última rodada passava direto (foi o que aconteceu com 2 deles em 31/07).
   *
   * A pausa aqui segue o mesmo contrato do script e de
   * `AuctionsService.retomarLeiloesDoVendedor`, que devolve o leilão ao ar
   * sozinho quando o vendedor fica apto: guarda a duração cheia em
   * `pausedRemainingMs` e joga `endsAt` na sentinela distante, que tira o leilão
   * da vitrine e do alcance do cron de encerramento.
   */
  private async startAuctionClockIfPending(listingId: string): Promise<void> {
    const [auction] = await this.db
      .select({
        id: schema.auctions.id,
        endsAt: schema.auctions.endsAt,
        durationHours: schema.auctions.durationHours,
        sellerId: schema.listings.sellerId,
        recipientId: schema.sellerProfiles.pagarmeRecipientId,
        canReceive: schema.sellerProfiles.canReceive,
      })
      .from(schema.auctions)
      .innerJoin(
        schema.listings,
        eq(schema.listings.id, schema.auctions.listingId),
      )
      .leftJoin(
        schema.sellerProfiles,
        eq(schema.sellerProfiles.userId, schema.listings.sellerId),
      )
      .where(eq(schema.auctions.listingId, listingId))
      .limit(1);

    if (!auction || auction.endsAt) return; // sem leilão ou já iniciado

    const duracaoMs = (auction.durationHours ?? 48) * 60 * 60 * 1000;
    const apto = Boolean(auction.recipientId && auction.canReceive);

    if (!apto) {
      await this.db
        .update(schema.auctions)
        .set({
          endsAt: FIM_SENTINELA,
          status: 'active',
          pausedAt: new Date(),
          pausedRemainingMs: duracaoMs,
          updatedAt: new Date(),
        })
        .where(eq(schema.auctions.id, auction.id));

      this.logger.warn(
        `[updateStatus] Leilão do anúncio ${listingId} nasceu PAUSADO: vendedor ` +
          `${auction.sellerId} sem recebedor apto na Pagar.me. Volta ao ar com ` +
          `${auction.durationHours ?? 48}h cheias quando o recebedor for ativado.`,
      );
      return;
    }

    const endsAt = new Date(Date.now() + duracaoMs);

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
            stock: mapped.stock,
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
