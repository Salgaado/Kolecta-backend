import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, and, desc, sql, gte, isNotNull } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import { motivoDeRecusa } from './link-externo';
import * as schema from '../database/schema';
import {
  CreatePostDto,
  UpdatePostDto,
  CreateCommentDto,
  CreateReportDto,
} from './dto/community.dto';

// Nº de denúncias abertas que oculta um post automaticamente (gating aberto → mitigação)
const AUTO_HIDE_THRESHOLD = 5;

// Pesos do ranking de relevância
const W_LIKE = 1;
const W_COMMENT = 2;
const W_SAVE = 3;
const W_PIN = 5;
const REPUTATION_WEIGHT = 2; // (avgRating - 3) * peso  → autor 5★ = +4, 1★ = -4
const TIME_DECAY_PER_HOUR = 0.5; // pontos perdidos por hora de idade
const SCORE_WINDOW_DAYS = 30; // só recomputa posts recentes

/**
 * Fórmula pura do score de relevância (testável sem banco).
 * score = likes + comments*2 + saves*3 + pins*5 + reputationBonus - timeDecay
 */
export function computePostScore(
  input: {
    likeCount: number;
    commentCount: number;
    saveCount: number;
    pinCount: number;
    avgRating?: number | null;
    createdAt: Date | number;
  },
  now: number = Date.now(),
): number {
  const reputationBonus =
    input.avgRating != null ? (input.avgRating - 3) * REPUTATION_WEIGHT : 0;
  const createdMs =
    input.createdAt instanceof Date
      ? input.createdAt.getTime()
      : Number(input.createdAt);
  const ageHours = Math.max(0, (now - createdMs) / 3_600_000);
  const timeDecay = ageHours * TIME_DECAY_PER_HOUR;

  return (
    input.likeCount * W_LIKE +
    input.commentCount * W_COMMENT +
    input.saveCount * W_SAVE +
    input.pinCount * W_PIN +
    reputationBonus -
    timeDecay
  );
}

export type FeedSort =
  | 'relevantes'
  | 'recentes'
  | 'mais_curtidos'
  | 'mais_salvos'
  | 'com_produto';

@Injectable()
export class CommunityService {
  constructor(
    @Inject(DATABASE_CONNECTION) private db: LibSQLDatabase<typeof schema>,
  ) {}

  // ── Gating ───────────────────────────────────────────────────────────────────
  // MVP "aberto": basta estar autenticado (AuthGuard) e não estar banido.
  private async _assertNotBanned(userId: string) {
    const ban = await this.db.query.communityBans.findFirst({
      where: eq(schema.communityBans.userId, userId),
    });
    if (ban) {
      throw new ForbiddenException(
        'Você está impedido de participar da comunidade.',
      );
    }
  }

  private parseImages(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string') : [];
    } catch {
      return [];
    }
  }

  // ── Posts: criar ─────────────────────────────────────────────────────────────

  async createPost(authorId: string, dto: CreatePostDto) {
    await this._assertNotBanned(authorId);

    let listingId: string | null = null;

    if (dto.type === 'product') {
      if (!dto.listingId) {
        throw new BadRequestException(
          'Posts de produto exigem um produto vinculado (listingId).',
        );
      }
      const listing = await this.db.query.listings.findFirst({
        where: eq(schema.listings.id, dto.listingId),
      });
      if (!listing) throw new NotFoundException('Produto não encontrado.');
      if (listing.status !== 'active') {
        throw new BadRequestException(
          'Só é possível vincular produtos ativos.',
        );
      }
      if (listing.sellerId !== authorId) {
        throw new ForbiddenException(
          'Você só pode vincular produtos do seu próprio catálogo.',
        );
      }
      listingId = listing.id;
    }

    if (dto.categoryId) {
      const category = await this.db.query.categories.findFirst({
        where: eq(schema.categories.id, dto.categoryId),
      });
      if (!category) throw new NotFoundException('Categoria não encontrada.');
    }

    const [post] = await this.db
      .insert(schema.communityPosts)
      .values({
        authorId,
        type: dto.type,
        title: dto.title,
        body: dto.body ?? null,
        images: dto.images ? JSON.stringify(dto.images) : null,
        categoryId: dto.categoryId ?? null,
        listingId,
      })
      .returning();

    return this._withParsedImages(post);
  }

  // ── Posts: atualizar (apenas autor) ──────────────────────────────────────────

  async updatePost(userId: string, postId: string, dto: UpdatePostDto) {
    await this._getOwnedPost(userId, postId);

    if (dto.categoryId) {
      const category = await this.db.query.categories.findFirst({
        where: eq(schema.categories.id, dto.categoryId),
      });
      if (!category) throw new NotFoundException('Categoria não encontrada.');
    }

    const patch: Partial<typeof schema.communityPosts.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.body !== undefined) patch.body = dto.body;
    if (dto.categoryId !== undefined) patch.categoryId = dto.categoryId;
    if (dto.images !== undefined) patch.images = JSON.stringify(dto.images);

    const [updated] = await this.db
      .update(schema.communityPosts)
      .set(patch)
      .where(eq(schema.communityPosts.id, postId))
      .returning();

    return this._withParsedImages(updated);
  }

  // ── Posts: excluir (apenas autor) ────────────────────────────────────────────

  async deletePost(userId: string, postId: string) {
    await this._getOwnedPost(userId, postId);
    await this.db
      .delete(schema.communityPosts)
      .where(eq(schema.communityPosts.id, postId));
    return { success: true };
  }

  private async _getOwnedPost(userId: string, postId: string) {
    const post = await this.db.query.communityPosts.findFirst({
      where: eq(schema.communityPosts.id, postId),
    });
    if (!post) throw new NotFoundException('Publicação não encontrada.');
    if (post.authorId !== userId) {
      throw new ForbiddenException('Você não pode editar esta publicação.');
    }
    return post;
  }

  // ── Posts: detalhe (público) ─────────────────────────────────────────────────

  async getPost(postId: string) {
    const [row] = await this.db
      .select({
        post: schema.communityPosts,
        author: { id: schema.users.id, name: schema.users.name },
        listing: {
          id: schema.listings.id,
          title: schema.listings.title,
          images: schema.listings.images,
          priceInCents: schema.listings.priceInCents,
          sellerId: schema.listings.sellerId,
        },
        category: {
          id: schema.categories.id,
          name: schema.categories.name,
          slug: schema.categories.slug,
        },
      })
      .from(schema.communityPosts)
      .leftJoin(schema.users, eq(schema.communityPosts.authorId, schema.users.id))
      .leftJoin(schema.listings, eq(schema.communityPosts.listingId, schema.listings.id))
      .leftJoin(schema.categories, eq(schema.communityPosts.categoryId, schema.categories.id))
      .where(eq(schema.communityPosts.id, postId));

    if (!row || row.post.status === 'removed') {
      throw new NotFoundException('Publicação não encontrada.');
    }

    return this._mapRow(row);
  }

  // ── Interações: like / save / pin (toggle idempotente) ───────────────────────

  async toggleLike(userId: string, postId: string) {
    return this._toggle(userId, postId, {
      table: schema.communityPostLikes,
      counterKey: 'likeCount',
      counterCol: schema.communityPosts.likeCount,
      key: 'liked',
    });
  }

  async toggleSave(userId: string, postId: string) {
    return this._toggle(userId, postId, {
      table: schema.communityPostSaves,
      counterKey: 'saveCount',
      counterCol: schema.communityPosts.saveCount,
      key: 'saved',
    });
  }

  async togglePin(userId: string, postId: string) {
    return this._toggle(userId, postId, {
      table: schema.communityPins,
      counterKey: 'pinCount',
      counterCol: schema.communityPosts.pinCount,
      key: 'pinned',
    });
  }

  private async _toggle(
    userId: string,
    postId: string,
    cfg: { table: any; counterKey: string; counterCol: any; key: string },
  ) {
    await this._assertNotBanned(userId);
    const post = await this.db.query.communityPosts.findFirst({
      where: eq(schema.communityPosts.id, postId),
    });
    if (!post) throw new NotFoundException('Publicação não encontrada.');

    const existing = await this.db
      .select()
      .from(cfg.table)
      .where(and(eq(cfg.table.postId, postId), eq(cfg.table.userId, userId)))
      .get();

    if (existing) {
      await this.db.delete(cfg.table).where(eq(cfg.table.id, existing.id));
      await this.db
        .update(schema.communityPosts)
        .set({ [cfg.counterKey]: sql`max(${cfg.counterCol} - 1, 0)` } as any)
        .where(eq(schema.communityPosts.id, postId));
      return { [cfg.key]: false };
    }

    await this.db.insert(cfg.table).values({ postId, userId });
    await this.db
      .update(schema.communityPosts)
      .set({ [cfg.counterKey]: sql`${cfg.counterCol} + 1` } as any)
      .where(eq(schema.communityPosts.id, postId));
    return { [cfg.key]: true };
  }

  // ── Comentários ──────────────────────────────────────────────────────────────

  async addComment(userId: string, postId: string, dto: CreateCommentDto) {
    await this._assertNotBanned(userId);

    // Bloqueia na ESCRITA, e não depois. Moderar link de concorrente é enxugar
    // gelo: quem posta um posta outro, e alguém precisa estar olhando. Ver
    // `link-externo.ts` para o caso que originou a regra.
    const recusa = motivoDeRecusa(dto.body);
    if (recusa) throw new BadRequestException(recusa);

    const post = await this.db.query.communityPosts.findFirst({
      where: eq(schema.communityPosts.id, postId),
    });
    if (!post || post.status !== 'active') {
      throw new NotFoundException('Publicação não encontrada.');
    }

    // Menção a anúncio: o par da regra de link externo. Tira o caminho de fora
    // e abre o de dentro, dando ao vendedor um motivo legítimo de participar.
    //
    // Confere ANTES de gravar: id inventado deixaria um card fantasma no
    // comentário, e anúncio fora do ar viraria propaganda de algo que ninguém
    // pode comprar.
    let listingId: string | null = null;
    if (dto.listingId) {
      const anuncio = await this.db.query.listings.findFirst({
        where: eq(schema.listings.id, dto.listingId),
      });
      if (!anuncio || anuncio.status !== 'active') {
        throw new BadRequestException(
          'O anúncio mencionado não existe ou não está no ar.',
        );
      }
      listingId = anuncio.id;
    }

    const [comment] = await this.db
      .insert(schema.communityComments)
      .values({ postId, authorId: userId, body: dto.body, listingId })
      .returning();

    await this.db
      .update(schema.communityPosts)
      .set({ commentCount: sql`${schema.communityPosts.commentCount} + 1` })
      .where(eq(schema.communityPosts.id, postId));

    return comment;
  }

  async getComments(postId: string) {
    return this.db
      .select({
        id: schema.communityComments.id,
        body: schema.communityComments.body,
        createdAt: schema.communityComments.createdAt,
        author: { id: schema.users.id, name: schema.users.name },
        // Card do anúncio mencionado. `leftJoin` porque a menção é opcional:
        // `innerJoin` sumiria com todo comentário que não menciona nada.
        listing: {
          id: schema.listings.id,
          title: schema.listings.title,
          priceInCents: schema.listings.priceInCents,
          images: schema.listings.images,
          type: schema.listings.type,
          status: schema.listings.status,
          // Leilão não usa `priceInCents`, então sem estes dois o card diria só
          // "Modo Lance", sem valor nenhum. São 114 leilões em 1.043 anúncios
          // ativos: uma menção em cada nove cairia nesse vazio.
          startingBidInCents: schema.auctions.startingBidInCents,
          currentBidInCents: schema.auctions.currentBidInCents,
        },
      })
      .from(schema.communityComments)
      .innerJoin(schema.users, eq(schema.communityComments.authorId, schema.users.id))
      .leftJoin(schema.listings, eq(schema.listings.id, schema.communityComments.listingId))
      .leftJoin(schema.auctions, eq(schema.auctions.listingId, schema.listings.id))
      .where(
        and(
          eq(schema.communityComments.postId, postId),
          eq(schema.communityComments.status, 'active'),
        ),
      )
      .orderBy(desc(schema.communityComments.createdAt));
  }

  // ── Feed ─────────────────────────────────────────────────────────────────────

  async getFeed(opts: {
    sort?: FeedSort;
    page?: number;
    limit?: number;
    categoryId?: string;
    type?: string;
  }) {
    const sort = opts.sort ?? 'relevantes';
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 50) : 20;
    const offset = (page - 1) * limit;

    const conditions = [eq(schema.communityPosts.status, 'active')];
    if (opts.categoryId)
      conditions.push(eq(schema.communityPosts.categoryId, opts.categoryId));
    if (opts.type) conditions.push(eq(schema.communityPosts.type, opts.type));
    if (sort === 'com_produto')
      conditions.push(isNotNull(schema.communityPosts.listingId));

    const orderBy =
      sort === 'recentes'
        ? desc(schema.communityPosts.createdAt)
        : sort === 'mais_curtidos'
          ? desc(schema.communityPosts.likeCount)
          : sort === 'mais_salvos'
            ? desc(schema.communityPosts.saveCount)
            : desc(schema.communityPosts.score); // relevantes | com_produto

    const rows = await this.db
      .select({
        post: schema.communityPosts,
        author: { id: schema.users.id, name: schema.users.name },
        listing: {
          id: schema.listings.id,
          title: schema.listings.title,
          images: schema.listings.images,
          priceInCents: schema.listings.priceInCents,
          sellerId: schema.listings.sellerId,
        },
        category: {
          id: schema.categories.id,
          name: schema.categories.name,
          slug: schema.categories.slug,
        },
      })
      .from(schema.communityPosts)
      .leftJoin(schema.users, eq(schema.communityPosts.authorId, schema.users.id))
      .leftJoin(schema.listings, eq(schema.communityPosts.listingId, schema.listings.id))
      .leftJoin(schema.categories, eq(schema.communityPosts.categoryId, schema.categories.id))
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const countRow = await this.db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(schema.communityPosts)
      .where(and(...conditions))
      .get();

    const total = countRow?.count ?? 0;

    return {
      data: rows.map((r) => this._mapRow(r)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ── Em alta na comunidade ─────────────────────────────────────────────────────

  async getHighlights() {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const topPost = await this.db
      .select({ post: schema.communityPosts })
      .from(schema.communityPosts)
      .where(
        and(
          eq(schema.communityPosts.status, 'active'),
          gte(schema.communityPosts.createdAt, since24h),
        ),
      )
      .orderBy(desc(schema.communityPosts.score))
      .limit(1)
      .get();

    const topProductPost = await this.db
      .select({ post: schema.communityPosts })
      .from(schema.communityPosts)
      .where(
        and(
          eq(schema.communityPosts.status, 'active'),
          eq(schema.communityPosts.type, 'product'),
        ),
      )
      .orderBy(desc(schema.communityPosts.saveCount))
      .limit(1)
      .get();

    const topCategory = await this.db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        slug: schema.categories.slug,
        icon: schema.categories.icon,
        posts: sql<number>`cast(count(${schema.communityPosts.id}) as integer)`,
      })
      .from(schema.communityPosts)
      .innerJoin(
        schema.categories,
        eq(schema.communityPosts.categoryId, schema.categories.id),
      )
      .where(
        and(
          eq(schema.communityPosts.status, 'active'),
          gte(schema.communityPosts.createdAt, since7d),
        ),
      )
      .groupBy(schema.categories.id)
      .orderBy(desc(sql`count(${schema.communityPosts.id})`))
      .limit(1)
      .get();

    return {
      topPost: topPost ? this._withParsedImages(topPost.post) : null,
      topProductPost: topProductPost
        ? this._withParsedImages(topProductPost.post)
        : null,
      topCategory: topCategory ?? null,
    };
  }

  // ── Top Trends por janela ─────────────────────────────────────────────────────

  async getTrends(window: '24h' | '7d' | 'month' = '24h', limit = 10) {
    const ms =
      window === '7d'
        ? 7 * 24 * 60 * 60 * 1000
        : window === 'month'
          ? 30 * 24 * 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - ms);

    const rows = await this.db
      .select({ post: schema.communityPosts })
      .from(schema.communityPosts)
      .where(
        and(
          eq(schema.communityPosts.status, 'active'),
          gte(schema.communityPosts.createdAt, since),
        ),
      )
      .orderBy(desc(schema.communityPosts.score))
      .limit(Math.min(limit, 50));

    return {
      window,
      posts: rows.map((r) => this._withParsedImages(r.post)),
    };
  }

  // ── Denúncia + auto-hide ──────────────────────────────────────────────────────

  async createReport(userId: string, dto: CreateReportDto) {
    await this._assertNotBanned(userId);

    const [report] = await this.db
      .insert(schema.communityReports)
      .values({
        targetType: dto.targetType,
        targetId: dto.targetId,
        reporterId: userId,
        reason: dto.reason,
        description: dto.description ?? null,
      })
      .returning();

    // Auto-hide de post ao atingir o limiar de denúncias abertas
    if (dto.targetType === 'post') {
      const openReports = await this.db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(schema.communityReports)
        .where(
          and(
            eq(schema.communityReports.targetType, 'post'),
            eq(schema.communityReports.targetId, dto.targetId),
            eq(schema.communityReports.status, 'open'),
          ),
        )
        .get();

      if ((openReports?.count ?? 0) >= AUTO_HIDE_THRESHOLD) {
        await this.db
          .update(schema.communityPosts)
          .set({ status: 'hidden', updatedAt: new Date() })
          .where(
            and(
              eq(schema.communityPosts.id, dto.targetId),
              eq(schema.communityPosts.status, 'active'),
            ),
          );
      }
    }

    return report;
  }

  // ── Moderação (admin) ─────────────────────────────────────────────────────────

  async listReports(status = 'open') {
    return this.db
      .select()
      .from(schema.communityReports)
      .where(eq(schema.communityReports.status, status))
      .orderBy(desc(schema.communityReports.createdAt));
  }

  async setPostStatus(postId: string, status: 'active' | 'hidden' | 'removed') {
    const post = await this.db.query.communityPosts.findFirst({
      where: eq(schema.communityPosts.id, postId),
    });
    if (!post) throw new NotFoundException('Publicação não encontrada.');

    await this.db
      .update(schema.communityPosts)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.communityPosts.id, postId));

    // Resolve denúncias abertas do post
    await this.db
      .update(schema.communityReports)
      .set({ status: 'reviewed', resolvedAt: new Date() })
      .where(
        and(
          eq(schema.communityReports.targetType, 'post'),
          eq(schema.communityReports.targetId, postId),
          eq(schema.communityReports.status, 'open'),
        ),
      );

    return { success: true, status };
  }


  /**
   * Oculta, remove ou restaura um COMENTÁRIO.
   *
   * A coluna `status` existia desde sempre em `community_comments`, e nunca
   * houve como mexer nela: o admin só conseguia moderar posts. Descoberto com
   * três comentários no ar apontando para a loja de um concorrente, ou seja,
   * um terço de tudo que havia comentado na comunidade.
   *
   * `hidden` some da listagem e dá para desfazer; `removed` é o caso do spam,
   * de quem não vai voltar. Nos dois casos o texto continua no banco, porque
   * apagar de vez destrói a prova de por que o autor foi banido depois.
   *
   * O contador do post é ajustado junto, senão ele mostraria "9 comentários"
   * numa lista com 6, e alguém iria caçar o bug errado.
   */
  async setCommentStatus(
    commentId: string,
    status: 'active' | 'hidden' | 'removed',
  ) {
    const comment = await this.db.query.communityComments.findFirst({
      where: eq(schema.communityComments.id, commentId),
    });
    if (!comment) throw new NotFoundException('Comentário não encontrado.');
    if (comment.status === status) return { success: true, status };

    await this.db
      .update(schema.communityComments)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.communityComments.id, commentId));

    // Sair de `active` desconta; voltar para `active` soma de novo.
    const delta = status === 'active' ? 1 : -1;
    await this.db
      .update(schema.communityPosts)
      .set({
        commentCount: sql`MAX(0, ${schema.communityPosts.commentCount} + ${delta})`,
        updatedAt: new Date(),
      })
      .where(eq(schema.communityPosts.id, comment.postId));

    // Resolve denúncias abertas deste comentário, igual ao fluxo de post.
    await this.db
      .update(schema.communityReports)
      .set({ status: 'reviewed', resolvedAt: new Date() })
      .where(
        and(
          eq(schema.communityReports.targetType, 'comment'),
          eq(schema.communityReports.targetId, commentId),
          eq(schema.communityReports.status, 'open'),
        ),
      );

    return { success: true, status };
  }

  /**
   * Tudo da comunidade para a tela de moderação, inclusive o que já foi
   * ocultado ou removido.
   *
   * A listagem pública esconde o que não está `active`, então sem isto o admin
   * não teria como achar o que moderar nem como desfazer o que ocultou.
   */
  async listarParaModeracao(status?: string) {
    const filtro = status && status !== 'todos' ? status : null;

    const posts = await this.db
      .select({
        id: schema.communityPosts.id,
        tipo: sql<string>`'post'`,
        titulo: schema.communityPosts.title,
        corpo: schema.communityPosts.body,
        status: schema.communityPosts.status,
        autorId: schema.communityPosts.authorId,
        autor: schema.users.name,
        postId: sql<string | null>`NULL`,
        createdAt: schema.communityPosts.createdAt,
      })
      .from(schema.communityPosts)
      .leftJoin(schema.users, eq(schema.users.id, schema.communityPosts.authorId))
      .where(filtro ? eq(schema.communityPosts.status, filtro) : undefined);

    const comentarios = await this.db
      .select({
        id: schema.communityComments.id,
        tipo: sql<string>`'comentario'`,
        titulo: sql<string | null>`NULL`,
        corpo: schema.communityComments.body,
        status: schema.communityComments.status,
        autorId: schema.communityComments.authorId,
        autor: schema.users.name,
        postId: schema.communityComments.postId,
        createdAt: schema.communityComments.createdAt,
      })
      .from(schema.communityComments)
      .leftJoin(schema.users, eq(schema.users.id, schema.communityComments.authorId))
      .where(filtro ? eq(schema.communityComments.status, filtro) : undefined);

    return [...posts, ...comentarios].sort(
      (a: any, b: any) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0),
    );
  }

  // ── Banimento ─────────────────────────────────────────────────────────────────

  async banUser(adminId: string, userId: string, reason?: string) {
    const existing = await this.db.query.communityBans.findFirst({
      where: eq(schema.communityBans.userId, userId),
    });
    if (existing) return { success: true, alreadyBanned: true };

    await this.db
      .insert(schema.communityBans)
      .values({ userId, reason: reason ?? null, bannedBy: adminId });
    return { success: true };
  }

  async unbanUser(userId: string) {
    await this.db
      .delete(schema.communityBans)
      .where(eq(schema.communityBans.userId, userId));
    return { success: true };
  }

  // ── Ranking: recomputar score (chamado pelo cron) ────────────────────────────

  async recomputeScores(): Promise<number> {
    const since = new Date(
      Date.now() - SCORE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const posts = await this.db
      .select({
        id: schema.communityPosts.id,
        authorId: schema.communityPosts.authorId,
        likeCount: schema.communityPosts.likeCount,
        commentCount: schema.communityPosts.commentCount,
        saveCount: schema.communityPosts.saveCount,
        pinCount: schema.communityPosts.pinCount,
        createdAt: schema.communityPosts.createdAt,
      })
      .from(schema.communityPosts)
      .where(
        and(
          eq(schema.communityPosts.status, 'active'),
          gte(schema.communityPosts.createdAt, since),
        ),
      );

    if (posts.length === 0) return 0;

    // Reputação do autor = média das reviews recebidas (targetId)
    const ratings = await this.db
      .select({
        authorId: schema.reviews.targetId,
        avg: sql<number>`avg(${schema.reviews.rating})`,
      })
      .from(schema.reviews)
      .groupBy(schema.reviews.targetId);

    const ratingMap = new Map(ratings.map((r) => [r.authorId, r.avg]));
    const now = Date.now();

    for (const p of posts) {
      const score = computePostScore(
        { ...p, avgRating: ratingMap.get(p.authorId) ?? null },
        now,
      );
      await this.db
        .update(schema.communityPosts)
        .set({ score, scoreUpdatedAt: new Date(now) })
        .where(eq(schema.communityPosts.id, p.id));
    }

    return posts.length;
  }

  // ── Helpers de mapeamento ─────────────────────────────────────────────────────

  private _withParsedImages<T extends { images: string | null }>(post: T) {
    return { ...post, images: this.parseImages(post.images) };
  }

  private _mapRow(row: {
    post: typeof schema.communityPosts.$inferSelect;
    author: { id: string | null; name: string | null } | null;
    listing: any;
    category: any;
  }) {
    return {
      ...row.post,
      images: this.parseImages(row.post.images),
      author: row.author,
      listing: row.listing?.id
        ? { ...row.listing, images: this.parseImages(row.listing.images) }
        : null,
      category: row.category?.id ? row.category : null,
    };
  }
}
