import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

export type UserRecord = typeof schema.users.$inferSelect;
export type UpdateUserDto = { name?: string; role?: string };

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  // ─── Buscar usuário pelo ID do Clerk ─────────────────────────────────────

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

  // ─── Atualizar dados do perfil ────────────────────────────────────────────

  async update(id: string, dto: UpdateUserDto): Promise<UserRecord> {
    // Verifica se o usuário existe antes de atualizar
    await this.findById(id);

    await this.db
      .update(schema.users)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(schema.users.id, id));

    this.logger.log(`Usuário atualizado: ${id}`);

    return this.findById(id);
  }
}
