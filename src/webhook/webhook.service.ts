import { Injectable, Inject, Logger } from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async handleEvent(evt: { type: string; data: any }): Promise<void> {
    switch (evt.type) {
      case 'user.created':
        await this.handleUserCreated(evt.data);
        break;
      case 'user.updated':
        await this.handleUserUpdated(evt.data);
        break;
      case 'user.deleted':
        await this.handleUserDeleted(evt.data);
        break;
      default:
        this.logger.log(`[Clerk Webhook] Evento ignorado: ${evt.type}`);
    }
  }

  /**
   * Nome de exibição a partir do payload do Clerk.
   *
   * Nem todo cadastro traz nome: quem entra só com e-mail e senha chega sem
   * `first_name`/`last_name`, e o código antigo gravava string VAZIA. Isso é
   * pior que nulo — passa batido por todo `?? 'Vendedor Kolecta'` (que só pega
   * null/undefined) e o anúncio aparecia na vitrine sem vendedor nenhum.
   *
   * Ordem: nome completo → username → parte local do e-mail. Nunca vazio.
   */
  private resolveDisplayName(data: any): string {
    const { first_name, last_name, username, email_addresses } = data;
    const completo = `${first_name ?? ''} ${last_name ?? ''}`.trim();
    if (completo) return completo;
    if (username?.trim()) return username.trim();
    const email: string | undefined = email_addresses?.[0]?.email_address;
    return email?.split('@')[0]?.trim() || 'Colecionador';
  }

  // ─── user.created ────────────────────────────────────────────────────────────

  /**
   * Foto do Clerk. A imagem já está hospedada lá, então guardamos a URL em vez
   * de copiar o arquivo. O Clerk sempre manda uma `image_url` — quando o usuário
   * não subiu foto, é o avatar gerado com as iniciais dele, que não serve de
   * nada aqui: o front já desenha as iniciais sozinho quando não há foto.
   * `has_image` separa uma coisa da outra.
   */
  private resolveAvatarUrl(data: any): string | null {
    if (data?.has_image === false) return null;
    const url: unknown = data?.image_url ?? data?.profile_image_url;
    return typeof url === 'string' && url.trim() ? url.trim() : null;
  }

  private async handleUserCreated(data: any): Promise<void> {
    const { id, email_addresses } = data;
    const email = email_addresses?.[0]?.email_address;
    const name = this.resolveDisplayName(data);
    const avatarUrl = this.resolveAvatarUrl(data);

    this.logger.log(`[user.created] ID: ${id} | Email: ${email}`);

    try {
      await this.db.insert(schema.users).values({ id, email, name, avatarUrl });
      this.logger.log(`[user.created] Usuário inserido no Turso com sucesso.`);

      // E-mail de boas-vindas. Emitido só depois do insert dar certo — não faz
      // sentido dar boas-vindas a quem não entrou no banco. O listener trata a
      // falha por conta própria; e-mail nunca derruba o webhook.
      this.eventEmitter.emit('user.registered', { id, email, name });
    } catch (err) {
      this.logger.error(`[user.created] Erro ao inserir usuário:`, err.message);
    }
  }

  // ─── user.updated ────────────────────────────────────────────────────────────

  private async handleUserUpdated(data: any): Promise<void> {
    const { id, email_addresses } = data;
    const email = email_addresses?.[0]?.email_address;
    const name = this.resolveDisplayName(data);
    const avatarUrl = this.resolveAvatarUrl(data);

    this.logger.log(`[user.updated] ID: ${id} | Novo email: ${email}`);

    try {
      await this.db
        .update(schema.users)
        .set({ email, name, avatarUrl, updatedAt: new Date() })
        .where(eq(schema.users.id, id));

      this.logger.log(
        `[user.updated] Usuário atualizado no Turso com sucesso.`,
      );
    } catch (err) {
      this.logger.error(
        `[user.updated] Erro ao atualizar usuário:`,
        err.message,
      );
    }
  }

  // ─── user.deleted ────────────────────────────────────────────────────────────

  private async handleUserDeleted(data: any): Promise<void> {
    const { id } = data;

    this.logger.log(`[user.deleted] ID: ${id}`);

    try {
      await this.db.delete(schema.users).where(eq(schema.users.id, id));

      this.logger.log(`[user.deleted] Usuário removido do Turso com sucesso.`);
    } catch (err) {
      this.logger.error(`[user.deleted] Erro ao remover usuário:`, err.message);
    }
  }
}
