/**
 * Promove (ou rebaixa) um usuário a admin pelo e-mail.
 *
 * Necessário para criar o PRIMEIRO admin: o endpoint
 * `PATCH /api/admin/users/:id/role` já exige ser admin (ovo-e-galinha).
 * A role fica em `users.role` no Turso e é a fonte de verdade — tanto o
 * RolesGuard do backend quanto o AuthContext do frontend (via /users/me)
 * leem daí, então a mudança vale imediatamente (sem mexer no Clerk).
 *
 * Pré-requisito: o usuário já precisa ter feito login pelo menos uma vez
 * (o Clerk cria a linha em `users` via webhook / findOrCreate).
 *
 * Aceita e-mail OU id do Clerk (`user_...`). Como os usuários reais do Clerk
 * podem estar com e-mail placeholder no Turso, prefira o id para contas reais.
 *
 * Uso:
 *   npx tsx src/database/make-admin.ts <email|user_id>         # promove a admin
 *   npx tsx src/database/make-admin.ts <email|user_id> user    # rebaixa a user
 *   npx tsx src/database/make-admin.ts --list                  # lista usuários
 */
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq, desc } from 'drizzle-orm';
import * as schema from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const db = drizzle(client, { schema });

async function listUsers() {
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .orderBy(desc(schema.users.createdAt));

  if (rows.length === 0) {
    console.log('Nenhum usuário na tabela `users` ainda.');
    return;
  }
  console.log(`Usuários (${rows.length}) — mais recentes primeiro:`);
  for (const u of rows) {
    const when = u.createdAt ? new Date(u.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '—';
    console.log(`  ${u.role === 'admin' ? '👑' : '  '} ${when}  ${u.email}  [${u.role}]  (${u.id})`);
  }
}

async function main() {
  const arg = process.argv[2];

  if (!arg || arg === '--list') {
    await listUsers();
    return;
  }

  const role = (process.argv[3] ?? 'admin').trim();
  if (role !== 'admin' && role !== 'user') {
    throw new Error(`Role inválida: "${role}". Use "admin" ou "user".`);
  }

  // Casa por id do Clerk (user_...) ou por e-mail.
  const byId = arg.startsWith('user_');
  const key = byId ? arg.trim() : arg.trim().toLowerCase();

  const [user] = await db
    .select()
    .from(schema.users)
    .where(byId ? eq(schema.users.id, key) : eq(schema.users.email, key))
    .limit(1);

  if (!user) {
    console.error(`❌ Nenhum usuário com ${byId ? 'id' : 'e-mail'} "${key}".`);
    console.error('   O usuário precisa ter feito login ao menos uma vez.\n');
    await listUsers();
    process.exit(1);
  }

  if (user.role === role) {
    console.log(`ℹ️  ${user.email} já é "${role}". Nada a fazer.`);
    return;
  }

  await db
    .update(schema.users)
    .set({ role, updatedAt: new Date() })
    .where(eq(schema.users.id, user.id));

  console.log(`✅ ${user.email} (${user.id}): ${user.role} → ${role}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
