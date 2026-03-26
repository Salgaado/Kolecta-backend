import { Injectable, Inject, Logger } from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
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

  // ─── user.created ────────────────────────────────────────────────────────────

  private async handleUserCreated(data: any): Promise<void> {
    const { id, email_addresses, first_name, last_name } = data;
    const email = email_addresses?.[0]?.email_address;
    const name = `${first_name ?? ''} ${last_name ?? ''}`.trim();

    this.logger.log(`[user.created] ID: ${id} | Email: ${email}`);

    try {
      await this.db.insert(schema.users).values({ id, email, name });
      this.logger.log(`[user.created] Usuário inserido no Turso com sucesso.`);
    } catch (err) {
      this.logger.error(`[user.created] Erro ao inserir usuário:`, err.message);
    }
  }

  // ─── user.updated ────────────────────────────────────────────────────────────

  private async handleUserUpdated(data: any): Promise<void> {
    const { id, email_addresses, first_name, last_name } = data;
    const email = email_addresses?.[0]?.email_address;
    const name = `${first_name ?? ''} ${last_name ?? ''}`.trim();

    this.logger.log(`[user.updated] ID: ${id} | Novo email: ${email}`);

    try {
      await this.db
        .update(schema.users)
        .set({ email, name, updatedAt: new Date() })
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
