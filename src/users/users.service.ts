import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { UpdateUserDto } from './dto/user.dto';
import { RecordConsentDto } from './dto/consent.dto';

export type UserRecord = typeof schema.users.$inferSelect;
// DTO movido para ./dto/user.dto.ts (classe, p/ o ValidationPipe global).
export { UpdateUserDto };

/**
 * Domínio do e-mail sintético usado quando o Clerk não respondeu na criação do
 * cadastro. Não existe como domínio de verdade: e-mail que termina assim NUNCA
 * é entregue, e é por isso que um cadastro nesse estado precisa ser reparado.
 */
const SUFIXO_PLACEHOLDER = '@placeholder.kolecta';

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
      // Cadastro que nasceu cego tem uma ÚNICA chance de ser consertado: aqui.
      // Sem isto o placeholder era definitivo — o `return` acima devolvia cedo
      // em toda chamada seguinte, e ninguém mais olhava para aquele registro.
      if (this.ehPlaceholder(result[0].email)) {
        return (await this.repararPlaceholder(result[0])) ?? result[0];
      }
      return result[0];
    }

    // Usuário não existe — criar registro mínimo
    this.logger.warn(`[findOrCreate] Auto-provisionando usuário: ${id}`);

    try {
      // Tenta obter dados do Clerk via SDK
      const clerkUser = await this.fetchClerkUser(id);
      const email =
        clerkUser?.emailAddresses?.[0]?.emailAddress ??
        `${id}@placeholder.kolecta`;
      const name =
        [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(' ') ||
        'Novo Usuário';

      await this.db.insert(schema.users).values({ id, email, name });
      this.logger.log(
        `[findOrCreate] Usuário criado no Turso: ${id} | ${email}`,
      );
    } catch (err) {
      // Cria mesmo assim: sem registro, a requisição que trouxe o usuário até
      // aqui falharia inteira. Mas ERROR, não WARN — este cadastro nasce sem
      // e-mail utilizável, e todo aviso que a plataforma mandar para ele cai no
      // vazio até alguém (ou a auto-cura acima) consertar.
      this.logger.error(
        `[findOrCreate] Clerk não respondeu para ${id} (${err.message}). ` +
          `Cadastro criado com e-mail PLACEHOLDER — nenhum e-mail chegará a ` +
          `este usuário até ser reparado.`,
      );
      await this.db.insert(schema.users).values({
        id,
        email: `${id}${SUFIXO_PLACEHOLDER}`,
        name: 'Novo Usuário',
      });
    }

    return this.findById(id);
  }

  /** E-mail sintético, gravado quando o Clerk não respondeu na criação. */
  private ehPlaceholder(email: string | null | undefined): boolean {
    return !!email?.endsWith(SUFIXO_PLACEHOLDER);
  }

  /**
   * Troca o cadastro cego pelos dados reais do Clerk, na primeira oportunidade.
   *
   * Em 08/08/2026 um comprador entrou por login do Google e o `GET /v1/users/{id}`
   * do Clerk falhou no instante do cadastro — a sessão já vale no callback, mas o
   * registro pode não ter propagado. `fetchClerkUser` estoura em QUALQUER resposta
   * não-2xx, então um 404 de meio segundo gravou nome e e-mail sintéticos. Ele
   * seguiu ativo: salvou cartão, deu dois lances e arrematou dois leilões — e os
   * avisos de arremate foram todos para `<id>@placeholder.kolecta`.
   *
   * Best-effort de propósito. Se o Clerk falhar de novo, devolve `null` e quem
   * chamou segue com o registro como está: consertar o cadastro não pode derrubar
   * uma requisição que só queria saber quem é o usuário. Na próxima chamada tenta
   * de novo, e é isso que torna a falha transitória em vez de permanente.
   */
  private async repararPlaceholder(
    atual: UserRecord,
  ): Promise<UserRecord | null> {
    try {
      const clerkUser = await this.fetchClerkUser(atual.id);
      const email: string | undefined =
        clerkUser?.emailAddresses?.[0]?.emailAddress;

      // Sem e-mail no Clerk não há o que curar — trocar placeholder por
      // placeholder só gastaria uma chamada por requisição, para sempre.
      if (!email || this.ehPlaceholder(email)) return null;

      const nome = [clerkUser?.firstName, clerkUser?.lastName]
        .filter(Boolean)
        .join(' ');

      await this.db
        .update(schema.users)
        .set({
          email,
          // Só sobrescreve o nome se o Clerk tiver um: melhor "Novo Usuário"
          // do que apagar o que o próprio usuário já tenha editado aqui.
          ...(nome ? { name: nome } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, atual.id));

      this.logger.log(
        `[findOrCreate] Cadastro placeholder reparado: ${atual.id} → ${email}`,
      );
      return this.findById(atual.id);
    } catch (err: any) {
      // `email` é UNIQUE: se outro registro já usa esse endereço, cai aqui —
      // e é caso de fusão manual, não de retry.
      this.logger.warn(
        `[findOrCreate] Não foi possível reparar o placeholder de ${atual.id}: ${err?.message}`,
      );
      return null;
    }
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
    const allowed: { name?: string; phone?: string; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (dto.name !== undefined) allowed.name = dto.name;
    // Telefone: guarda só dígitos e exige DDD + número (10 ou 11). Número curto
    // é erro de digitação, não "limpar o campo" — recusa em vez de gravar lixo.
    if (dto.phone !== undefined) {
      const digits = String(dto.phone).replace(/[^0-9]/g, '');
      if (digits.length < 10 || digits.length > 11) {
        throw new BadRequestException(
          'Telefone inválido: informe DDD + número (10 ou 11 dígitos).',
        );
      }
      allowed.phone = digits;
    }

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
