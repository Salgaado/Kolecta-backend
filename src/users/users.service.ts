import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { UpdateUserDto } from './dto/user.dto';
import { RecordConsentDto } from './dto/consent.dto';

export type UserRecord = typeof schema.users.$inferSelect;
// DTO movido para ./dto/user.dto.ts (classe, p/ o ValidationPipe global).
export { UpdateUserDto };

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  // ─── Buscar usuário pelo ID do Clerk ─────────────────────────────────────

  /**
   * Guarda CPF e telefone usados nas transações Pagar.me (só dígitos).
   *
   * A API exige documento E telefone no `customer` para autorizar cartão. Como
   * o lance cobra pelo `customer_id`, esses dados precisam estar gravados —
   * não basta mandá-los inline no checkout. Dado sensível (LGPD): não logar.
   */
  async persistPagarmeContact(userId: string, cpf?: string, phone?: string) {
    const patch: Record<string, unknown> = {};
    const cpfDigits = String(cpf ?? '').replace(/[^0-9]/g, '');
    if (cpfDigits.length === 11 || cpfDigits.length === 14) {
      patch.cpf = cpfDigits;
    }
    const phoneDigits = String(phone ?? '').replace(/[^0-9]/g, '');
    if (phoneDigits.length >= 10 && phoneDigits.length <= 11) {
      patch.phone = phoneDigits;
    }
    if (Object.keys(patch).length === 0) return;
    await this.db
      .update(schema.users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  }

  async findById(id: string): Promise<UserRecord> {
    const result = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);

    if (!result.length) {
      this.logger.warn(`Usuário não encontrado no Turso: ${id}`);
      throw new NotFoundException('Usuário não encontrado.');
    }

    return result[0];
  }

  // ─── Buscar ou criar usuário (auto-provision) ──────────────────────────────
  // Se o webhook do Clerk não disparou, cria o registro mínimo para destravar.

  async findOrCreate(id: string): Promise<UserRecord> {
    const result = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);

    if (result.length) {
      return result[0];
    }

    // Usuário não existe — criar registro mínimo
    this.logger.warn(`[findOrCreate] Auto-provisionando usuário: ${id}`);

    try {
      // Tenta obter dados do Clerk via SDK
      const clerkUser = await this.fetchClerkUser(id);
      const email = clerkUser?.emailAddresses?.[0]?.emailAddress ?? `${id}@placeholder.kolecta`;
      const name = [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(' ') || 'Novo Usuário';

      await this.db.insert(schema.users).values({ id, email, name });
      this.logger.log(`[findOrCreate] Usuário criado no Turso: ${id} | ${email}`);
    } catch (err) {
      // Se falhar ao buscar do Clerk, cria com dados mínimos
      this.logger.warn(`[findOrCreate] Fallback (sem dados do Clerk): ${err.message}`);
      await this.db.insert(schema.users).values({
        id,
        email: `${id}@placeholder.kolecta`,
        name: 'Novo Usuário',
      });
    }

    return this.findById(id);
  }

  // ─── Buscar dados do Clerk via API ──────────────────────────────────────────

  private async fetchClerkUser(userId: string): Promise<any> {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      throw new Error('CLERK_SECRET_KEY não configurada');
    }

    const response = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });

    if (!response.ok) {
      throw new Error(`Clerk API retornou ${response.status}`);
    }

    return response.json();
  }

  // ─── Atualizar dados do perfil ────────────────────────────────────────────

  async update(id: string, dto: UpdateUserDto): Promise<UserRecord> {
    // Verifica se o usuário existe antes de atualizar
    await this.findById(id);

    // Defense-in-depth: monta o set apenas com campos permitidos no self-service.
    // `role` NUNCA é alterável por aqui (privesc) — usar /api/admin/users/:id/role.
    const allowed: { name?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (dto.name !== undefined) allowed.name = dto.name;

    await this.db
      .update(schema.users)
      .set(allowed)
      .where(eq(schema.users.id, id));

    this.logger.log(`Usuário atualizado: ${id}`);

    return this.findById(id);
  }

  // ─── Registrar consentimento legal (Termos + LGPD) ──────────────────────────
  // Idempotente: só grava se ainda não houver aceite registrado para o usuário,
  // preservando o primeiro consentimento (o juridicamente relevante).

  async recordConsent(id: string, dto: RecordConsentDto): Promise<UserRecord> {
    const user = await this.findOrCreate(id);

    if (user.termsAcceptedAt) {
      // Já consentiu antes — não sobrescreve o registro original.
      return user;
    }

    await this.db
      .update(schema.users)
      .set({
        termsVersion: dto.termsVersion,
        termsAcceptedAt: new Date(dto.termsAcceptedAt),
        lgpdAcceptedAt: new Date(dto.lgpdAcceptedAt),
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, id));

    this.logger.log(`Consentimento registrado: ${id} (v${dto.termsVersion})`);

    return this.findById(id);
  }
}
