import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, and, inArray, isNotNull, gte, lte, sql } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import {
  FOUNDER_QUALIFY_LISTINGS,
  FOUNDER_TOTAL_SLOTS,
  LANDING_RANGE,
  INVITE_RANGE,
  FOUNDER_HIGHLIGHT_CREDITS,
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

  // ── T2: Qualificação + atribuição de número ──────────────────────────────────

  /**
   * Avalia (idempotente) se o usuário deve virar fundador. Chamável a qualquer
   * momento — na leitura do perfil ou após enviar um anúncio.
   * Retorna o perfil atualizado.
   */
  async evaluate(userId: string): Promise<SellerProfile> {
    const profile = await this.getOrCreateProfile(userId);

    // Já é fundador (active/lapsed) → nada a promover; número é permanente.
    if (profile.founderNumber != null) return profile;

    const submitted = await this.countSubmittedListings(userId);

    if (submitted < FOUNDER_QUALIFY_LISTINGS) {
      // Ainda não qualificou: marca 'pending' se estava 'none' (mostra progresso).
      if (profile.founderStatus === 'none') {
        const [updated] = await this.db
          .update(schema.sellerProfiles)
          .set({ founderStatus: 'pending', updatedAt: this.base() })
          .where(eq(schema.sellerProfiles.userId, userId))
          .returning();
        return updated;
      }
      return profile;
    }

    // Qualificou: tenta atribuir o próximo número livre da faixa da landing.
    return this.promoteToActive(userId);
  }

  /**
   * Atribui número (faixa landing 51..100) e ativa o fundador, de forma
   * resiliente a concorrência: o índice único uq_seller_founder_number é o
   * backstop; em colisão, tenta o próximo número.
   */
  private async promoteToActive(userId: string): Promise<SellerProfile> {
    const now = this.base();

    for (let attempt = 0; attempt < FOUNDER_TOTAL_SLOTS; attempt++) {
      const nextNumber = await this.nextLandingNumber();
      if (nextNumber == null) {
        // Vagas esgotadas — mantém 'pending'. Decisão de produto (fila x encerrar)
        // ainda em aberto; por ora não vira fundador.
        this.logger.warn(
          `Vagas de fundador esgotadas ao avaliar ${userId} (100/100).`,
        );
        const [p] = await this.db
          .select()
          .from(schema.sellerProfiles)
          .where(eq(schema.sellerProfiles.userId, userId));
        return p;
      }

      try {
        const [updated] = await this.db
          .update(schema.sellerProfiles)
          .set({
            founderNumber: nextNumber,
            founderStatus: 'active',
            founderSince: now,
            founderLastActiveListingAt: now,
            updatedAt: now,
          })
          .where(eq(schema.sellerProfiles.userId, userId))
          .returning();

        await this.grantCredits(userId, now);
        this.logger.log(
          `🏅 Fundador ativado: ${userId} → #${String(nextNumber).padStart(3, '0')}`,
        );
        return updated;
      } catch (err: any) {
        // Colisão no índice único: outro usuário pegou esse número. Tenta o próximo.
        if (this.isUniqueViolation(err)) {
          this.logger.warn(
            `Colisão de número #${nextNumber} p/ ${userId}; tentando próximo.`,
          );
          continue;
        }
        throw err;
      }
    }

    throw new ConflictException(
      'Não foi possível atribuir um número de fundador. Tente novamente.',
    );
  }

  /** Próximo número livre em [51..100], ou null se a faixa acabou. */
  private async nextLandingNumber(): Promise<number | null> {
    const [row] = await this.db
      .select({ max: sql<number>`max(${schema.sellerProfiles.founderNumber})` })
      .from(schema.sellerProfiles)
      .where(
        and(
          gte(schema.sellerProfiles.founderNumber, LANDING_RANGE.min),
          lte(schema.sellerProfiles.founderNumber, LANDING_RANGE.max),
        ),
      );
    const next = row?.max == null ? LANDING_RANGE.min : Number(row.max) + 1;
    return next > LANDING_RANGE.max ? null : next;
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
