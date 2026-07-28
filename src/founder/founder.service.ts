import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, and, inArray, isNotNull, gte, lte, sql } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import {
  FOUNDER_QUALIFY_LISTINGS,
  GRANT_RANGE,
  NUMERO_DA_CASA,
  INVITE_RANGE,
  FOUNDER_HIGHLIGHT_CREDITS,
  FOUNDER_HIGHLIGHT_DAYS,
  FOUNDER_BENEFIT_MONTHS,
  FOUNDER_COMMISSION_PERCENT,
  FOUNDER_LAPSE_DAYS,
  SUBMITTED_LISTING_STATUSES,
  ACTIVE_LISTING_STATUS,
} from './founder.constants';

type SellerProfile = typeof schema.sellerProfiles.$inferSelect;

/**
 * Regras do Programa Membro Fundador (pré-lançamento).
 * Ver docs/PLAN-programa-fundadores.md (T2–T7).
 *
 * Depende apenas do banco — não importa Orders/Auctions, para que esses módulos
 * possam depender daqui (resolução da taxa) sem ciclo.
 */
@Injectable()
export class FounderService {
  private readonly logger = new Logger(FounderService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  private base(): Date {
    return new Date();
  }

  private benefitEnd(founderSince: Date): Date {
    const end = new Date(founderSince);
    end.setMonth(end.getMonth() + FOUNDER_BENEFIT_MONTHS);
    return end;
  }

  // ── Perfil ─────────────────────────────────────────────────────────────────

  private async getOrCreateProfile(userId: string): Promise<SellerProfile> {
    const [existing] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));
    if (existing) return existing;

    const [created] = await this.db
      .insert(schema.sellerProfiles)
      .values({ userId })
      .returning();
    return created;
  }

  private async countSubmittedListings(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.listings)
      .where(
        and(
          eq(schema.listings.sellerId, userId),
          inArray(schema.listings.status, [...SUBMITTED_LISTING_STATUSES]),
        ),
      );
    return Number(row?.count ?? 0);
  }

  private async hasActiveListing(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.listings)
      .where(
        and(
          eq(schema.listings.sellerId, userId),
          eq(schema.listings.status, ACTIVE_LISTING_STATUS),
        ),
      );
    return Number(row?.count ?? 0) > 0;
  }

  // ── T2: Qualificação (candidato) — SEM concessão automática ─────────────────

  /**
   * Avalia (idempotente) o PROGRESSO do usuário no programa e ajusta só o
   * `founderStatus` da fase de candidatura — NUNCA concede o selo. A seleção dos
   * 100 fundadores é curada pela equipe (ver `grantFounder`). Estados:
   *  - `pending`   → ainda não bateu a meta de anúncios (mostra progresso);
   *  - `qualified` → bateu a meta (é CANDIDATO, aguardando concessão do admin).
   * Fundador já concedido (founderNumber != null) ou 'active'/'lapsed' não muda.
   */
  async evaluate(userId: string): Promise<SellerProfile> {
    const profile = await this.getOrCreateProfile(userId);

    // Já é fundador (número atribuído pela equipe) → estado curado, não mexe.
    if (
      profile.founderNumber != null ||
      profile.founderStatus === 'active' ||
      profile.founderStatus === 'lapsed'
    ) {
      return profile;
    }

    const submitted = await this.countSubmittedListings(userId);
    const desired =
      submitted >= FOUNDER_QUALIFY_LISTINGS ? 'qualified' : 'pending';

    if (profile.founderStatus === desired) return profile;

    const [updated] = await this.db
      .update(schema.sellerProfiles)
      .set({ founderStatus: desired, updatedAt: this.base() })
      .where(eq(schema.sellerProfiles.userId, userId))
      .returning();
    return updated;
  }

  // ── T2b: Concessão do selo pela EQUIPE (admin) ───────────────────────────────

  /**
   * Concede o selo de Fundador a um CANDIDATO, com número escolhido pela equipe
   * (sequência 1..100, mais o #0 da casa). Valida qualificação, faixa e unicidade
   * do número; o índice único `uq_seller_founder_number` é o backstop contra
   * corrida. Ativa o fundador, grava `founderSince` e concede os créditos.
   */
  async grantFounder(
    userId: string,
    founderNumber: number,
  ): Promise<SellerProfile> {
    const naSequencia =
      founderNumber >= GRANT_RANGE.min && founderNumber <= GRANT_RANGE.max;
    if (
      !Number.isInteger(founderNumber) ||
      (founderNumber !== NUMERO_DA_CASA && !naSequencia)
    ) {
      throw new BadRequestException(
        `Número deve ser ${NUMERO_DA_CASA} (a casa) ou estar entre ` +
          `${GRANT_RANGE.min} e ${GRANT_RANGE.max}.`,
      );
    }

    const profile = await this.getOrCreateProfile(userId);
    if (profile.founderNumber != null) {
      throw new ConflictException(
        `Este usuário já é fundador (#${profile.founderNumber}).`,
      );
    }

    // Candidato = atingiu a meta de anúncios enviados.
    const submitted = await this.countSubmittedListings(userId);
    if (submitted < FOUNDER_QUALIFY_LISTINGS) {
      throw new BadRequestException(
        `Candidato não qualificado (${submitted}/${FOUNDER_QUALIFY_LISTINGS} anúncios enviados).`,
      );
    }

    // Número livre? (checagem explícita além do índice único, p/ erro claro.)
    const [taken] = await this.db
      .select({ userId: schema.sellerProfiles.userId })
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.founderNumber, founderNumber));
    if (taken) {
      throw new ConflictException(`Número #${founderNumber} já está em uso.`);
    }

    const now = this.base();
    try {
      const [updated] = await this.db
        .update(schema.sellerProfiles)
        .set({
          founderNumber,
          founderStatus: 'active',
          founderSince: now,
          founderLastActiveListingAt: now,
          updatedAt: now,
        })
        .where(eq(schema.sellerProfiles.userId, userId))
        .returning();

      await this.grantCredits(userId, now);
      await this.queimarConviteDoMesmoNumero(userId, founderNumber, now);
      this.logger.log(
        `🏅 Fundador CONCEDIDO pela equipe: ${userId} → #${String(founderNumber).padStart(3, '0')}`,
      );
      return updated;
    } catch (err: any) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(`Número #${founderNumber} já está em uso.`);
      }
      throw err;
    }
  }

  /**
   * Lista os CANDIDATOS a fundador (qualificaram por anúncios, ainda sem número)
   * para a fila de concessão do admin, com o próximo número livre sugerido.
   */
  async listCandidates(): Promise<{
    candidates: Array<{
      userId: string;
      name: string | null;
      email: string | null;
      submitted: number;
      founderStatus: string;
    }>;
    nextNumber: number | null;
  }> {
    const counts = await this.db
      .select({
        sellerId: schema.listings.sellerId,
        n: sql<number>`count(*)`,
      })
      .from(schema.listings)
      .where(inArray(schema.listings.status, [...SUBMITTED_LISTING_STATUSES]))
      .groupBy(schema.listings.sellerId);

    const qualified = counts.filter(
      (c) => Number(c.n) >= FOUNDER_QUALIFY_LISTINGS,
    );
    const nextNumber = await this.nextGrantNumber();
    if (qualified.length === 0) return { candidates: [], nextNumber };

    const ids = qualified.map((c) => c.sellerId);
    const [profiles, users] = await Promise.all([
      this.db
        .select({
          userId: schema.sellerProfiles.userId,
          founderNumber: schema.sellerProfiles.founderNumber,
          founderStatus: schema.sellerProfiles.founderStatus,
        })
        .from(schema.sellerProfiles)
        .where(inArray(schema.sellerProfiles.userId, ids)),
      this.db
        .select({
          id: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
        })
        .from(schema.users)
        .where(inArray(schema.users.id, ids)),
    ]);
    const profByUser = new Map(profiles.map((p) => [p.userId, p]));
    const userById = new Map(users.map((u) => [u.id, u]));

    const candidates = qualified
      // Ainda NÃO concedido (sem número). Já-fundadores saem da fila.
      .filter((c) => (profByUser.get(c.sellerId)?.founderNumber ?? null) == null)
      .map((c) => ({
        userId: c.sellerId,
        name: userById.get(c.sellerId)?.name ?? null,
        email: userById.get(c.sellerId)?.email ?? null,
        submitted: Number(c.n),
        founderStatus: profByUser.get(c.sellerId)?.founderStatus ?? 'qualified',
      }));

    return { candidates, nextNumber };
  }

  /** Próximo número livre em [1..100], ou null se a sequência acabou. */
  private async nextGrantNumber(): Promise<number | null> {
    const [row] = await this.db
      .select({ max: sql<number>`max(${schema.sellerProfiles.founderNumber})` })
      .from(schema.sellerProfiles)
      .where(
        and(
          gte(schema.sellerProfiles.founderNumber, GRANT_RANGE.min),
          lte(schema.sellerProfiles.founderNumber, GRANT_RANGE.max),
        ),
      );
    const next = row?.max == null ? GRANT_RANGE.min : Number(row.max) + 1;
    return next > GRANT_RANGE.max ? null : next;
  }

  /**
   * Concessão manual e código de evento disputam a mesma faixa 1..50: o seed
   * `KOLECTA-FND-001..050` (rodado em prod em 15/07) reservou um código para cada
   * número, e o sorteio de 25/07 concedeu #001 a #010 direto no banco. Sem isto,
   * quem chegasse com o código do número já concedido bateria no índice único e
   * receberia um erro sem explicação.
   *
   * O número passa a ser do usuário premiado independentemente da porta por onde
   * entrou, então o código equivalente é dado como usado por ele. Silencioso de
   * propósito: número fora da faixa de convite simplesmente não casa com nada.
   */
  private async queimarConviteDoMesmoNumero(
    userId: string,
    founderNumber: number,
    now: Date,
  ): Promise<void> {
    const queimado = await this.db
      .update(schema.founderInviteCodes)
      .set({ redeemedByUserId: userId, redeemedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.founderInviteCodes.founderNumber, founderNumber),
          sql`${schema.founderInviteCodes.redeemedByUserId} is null`,
        ),
      )
      .returning({ code: schema.founderInviteCodes.code });

    if (queimado.length > 0) {
      this.logger.log(
        `🎟️ Código ${queimado[0].code} baixado junto da concessão #${founderNumber} (mesmo número).`,
      );
    }
  }

  private isUniqueViolation(err: any): boolean {
    const msg = String(err?.message ?? err ?? '').toLowerCase();
    return msg.includes('unique') || msg.includes('constraint');
  }

  // ── T5: Créditos de destaque ─────────────────────────────────────────────────

  private async grantCredits(userId: string, since: Date): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(schema.founderCredits)
      .where(eq(schema.founderCredits.userId, userId));
    if (existing) return; // já concedido (idempotente)

    const expiresAt = this.benefitEnd(since);
    await this.db.insert(schema.founderCredits).values({
      userId,
      creditsTotal: FOUNDER_HIGHLIGHT_CREDITS,
      creditsUsed: 0,
      expiresAt,
    });
  }

  /**
   * Consome 1 crédito de destaque do fundador e coloca o anúncio em destaque por
   * FOUNDER_HIGHLIGHT_DAYS dias. Só fundador `active`, dono do anúncio, com
   * crédito disponível e não expirado. Atômico (débito + destaque na mesma tx).
   */
  async useCredit(userId: string, listingId: string) {
    const [profile] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!profile || profile.founderStatus !== 'active') {
      throw new ForbiddenException(
        'Apenas fundadores ativos podem usar créditos de destaque.',
      );
    }

    const [credits] = await this.db
      .select()
      .from(schema.founderCredits)
      .where(eq(schema.founderCredits.userId, userId));

    if (!credits) {
      throw new NotFoundException('Você não tem carteira de créditos.');
    }
    if (credits.expiresAt && this.base() >= new Date(credits.expiresAt)) {
      throw new BadRequestException('Seus créditos de destaque expiraram.');
    }
    const available = credits.creditsTotal - credits.creditsUsed;
    if (available <= 0) {
      throw new BadRequestException('Você não tem créditos de destaque disponíveis.');
    }

    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, listingId));

    if (!listing) throw new NotFoundException('Anúncio não encontrado.');
    if (listing.sellerId !== userId) {
      throw new ForbiddenException('Este anúncio não é seu.');
    }
    if (listing.status !== ACTIVE_LISTING_STATUS) {
      throw new BadRequestException('Só é possível destacar um anúncio ativo.');
    }

    const now = this.base();
    const featuredUntil = new Date(
      now.getTime() + FOUNDER_HIGHLIGHT_DAYS * 86_400_000,
    );

    await this.db.transaction(async (tx) => {
      // Débito condicionado ao saldo atual (trava contra duplo-gasto concorrente).
      const debited = await tx
        .update(schema.founderCredits)
        .set({ creditsUsed: credits.creditsUsed + 1, updatedAt: now })
        .where(
          and(
            eq(schema.founderCredits.userId, userId),
            eq(schema.founderCredits.creditsUsed, credits.creditsUsed),
          ),
        )
        .returning();

      if (debited.length === 0) {
        throw new ConflictException('Crédito já consumido. Tente novamente.');
      }

      await tx
        .update(schema.listings)
        .set({
          featuredUntil,
          featuredSource: 'founder_credit',
          updatedAt: now,
        })
        .where(eq(schema.listings.id, listingId));
    });

    this.logger.log(
      `✨ Destaque: ${userId} usou 1 crédito em ${listingId} (até ${featuredUntil.toISOString()}).`,
    );

    return {
      listingId,
      featuredUntil,
      creditsAvailable: available - 1,
    };
  }

  // ── T3: Resgate de código de convite (faixa 1..50) ───────────────────────────

  async redeemInviteCode(userId: string, rawCode: string): Promise<SellerProfile> {
    const code = (rawCode ?? '').trim().toUpperCase();
    if (!code) throw new BadRequestException('Código inválido.');

    const profile = await this.getOrCreateProfile(userId);
    if (profile.founderNumber != null) {
      throw new ConflictException('Você já é um Membro Fundador.');
    }

    const [invite] = await this.db
      .select()
      .from(schema.founderInviteCodes)
      .where(eq(schema.founderInviteCodes.code, code));

    if (!invite) throw new NotFoundException('Código não encontrado.');
    if (invite.redeemedByUserId) {
      throw new ConflictException('Código já utilizado.');
    }
    if (invite.founderNumber < INVITE_RANGE.min || invite.founderNumber > INVITE_RANGE.max) {
      throw new BadRequestException('Código com número fora da faixa de convite.');
    }

    const now = this.base();
    // Marca o código como resgatado condicionando a redeemedByUserId ainda nulo
    // (trava contra corrida entre dois resgates do mesmo código).
    const claimed = await this.db
      .update(schema.founderInviteCodes)
      .set({ redeemedByUserId: userId, redeemedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.founderInviteCodes.id, invite.id),
          sql`${schema.founderInviteCodes.redeemedByUserId} is null`,
        ),
      )
      .returning();

    if (claimed.length === 0) {
      throw new ConflictException('Código já utilizado.');
    }

    const [updated] = await this.db
      .update(schema.sellerProfiles)
      .set({
        founderNumber: invite.founderNumber,
        founderStatus: 'active',
        founderSince: now,
        founderLastActiveListingAt: now,
        updatedAt: now,
      })
      .where(eq(schema.sellerProfiles.userId, userId))
      .returning();

    await this.grantCredits(userId, now);
    this.logger.log(
      `🎟️ Convite ${code} resgatado por ${userId} → #${String(invite.founderNumber).padStart(3, '0')}`,
    );
    return updated;
  }

  // ── T4: Resolução da comissão efetiva ────────────────────────────────────────

  /**
   * Comissão (%) aplicável a uma venda deste vendedor. Fundador 'active' dentro
   * da janela de 6 meses paga FOUNDER_COMMISSION_PERCENT; senão, a taxa base
   * (PLATFORM_FEE_PERCENT, default 11). Chamado no fechamento do pedido/leilão.
   */
  async resolveCommissionPercent(sellerId: string): Promise<number> {
    const base = parseInt(process.env.PLATFORM_FEE_PERCENT ?? '11', 10);

    const [profile] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, sellerId));

    if (
      !profile ||
      profile.founderStatus !== 'active' ||
      !profile.founderSince
    ) {
      return base;
    }

    if (this.base() < this.benefitEnd(profile.founderSince)) {
      return FOUNDER_COMMISSION_PERCENT;
    }
    return base;
  }

  // ── T7: Leitura do selo ──────────────────────────────────────────────────────

  /** Info pública do selo (para render no card/perfil). null se não é fundador. */
  async getPublicBadge(
    userId: string,
  ): Promise<{ founderNumber: number; founderStatus: string } | null> {
    const [profile] = await this.db
      .select({
        founderNumber: schema.sellerProfiles.founderNumber,
        founderStatus: schema.sellerProfiles.founderStatus,
      })
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!profile || profile.founderNumber == null) return null;
    return {
      founderNumber: profile.founderNumber,
      founderStatus: profile.founderStatus,
    };
  }

  /** Estado completo do fundador para o próprio usuário (avalia de forma lazy). */
  async getMyStatus(userId: string) {
    const profile = await this.evaluate(userId);
    const submitted = await this.countSubmittedListings(userId);
    const [credits] = await this.db
      .select()
      .from(schema.founderCredits)
      .where(eq(schema.founderCredits.userId, userId));

    return {
      founderNumber: profile.founderNumber,
      founderStatus: profile.founderStatus,
      founderSince: profile.founderSince,
      listingsSubmitted: submitted,
      listingsRequired: FOUNDER_QUALIFY_LISTINGS,
      remaining: Math.max(0, FOUNDER_QUALIFY_LISTINGS - submitted),
      benefitEndsAt: profile.founderSince
        ? this.benefitEnd(profile.founderSince)
        : null,
      credits: credits
        ? {
            total: credits.creditsTotal,
            used: credits.creditsUsed,
            available: Math.max(0, credits.creditsTotal - credits.creditsUsed),
            expiresAt: credits.expiresAt,
          }
        : null,
    };
  }

  // ── T6: Manutenção (regra dos 15 dias) ───────────────────────────────────────

  /**
   * Para cada fundador 'active': se tem anúncio ativo, renova o carimbo de
   * atividade; se está há >= 15 dias sem nenhum anúncio ativo, cai para 'lapsed'
   * (perde taxa 9% e congela créditos; mantém número e selo).
   */
  async runMaintenance(now: Date = this.base()): Promise<{ lapsed: number }> {
    const actives = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(
        and(
          eq(schema.sellerProfiles.founderStatus, 'active'),
          isNotNull(schema.sellerProfiles.founderNumber),
        ),
      );

    let lapsed = 0;
    for (const profile of actives) {
      const active = await this.hasActiveListing(profile.userId);
      if (active) {
        await this.db
          .update(schema.sellerProfiles)
          .set({ founderLastActiveListingAt: now, updatedAt: now })
          .where(eq(schema.sellerProfiles.userId, profile.userId));
        continue;
      }

      const last =
        profile.founderLastActiveListingAt ??
        profile.founderSince ??
        profile.createdAt;
      const days = (now.getTime() - new Date(last).getTime()) / 86_400_000;
      if (days >= FOUNDER_LAPSE_DAYS) {
        await this.db
          .update(schema.sellerProfiles)
          .set({ founderStatus: 'lapsed', updatedAt: now })
          .where(eq(schema.sellerProfiles.userId, profile.userId));
        lapsed++;
        this.logger.log(
          `⏳ Fundador #${profile.founderNumber} (${profile.userId}) → lapsed (${Math.floor(days)}d sem anúncio ativo).`,
        );
      }
    }

    if (lapsed > 0) this.logger.log(`Manutenção de fundadores: ${lapsed} lapsed.`);
    return { lapsed };
  }
}
