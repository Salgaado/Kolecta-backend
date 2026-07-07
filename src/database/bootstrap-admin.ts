/**
 * Bootstrap do primeiro admin usando o Clerk como fonte de verdade.
 *
 * Como os usuários reais podem estar no Turso com e-mail placeholder
 * (`user_XXX@placeholder.kolecta`), este script lista os usuários direto da
 * API do Clerk (e-mail real) e permite promover o escolhido a admin — casando
 * pelo id do Clerk (que é o mesmo id em `users.id` no Turso). De quebra,
 * corrige o e-mail/nome placeholder daquela linha.
 *
 * A instância do Clerk é definida pela CLERK_SECRET_KEY do .env
 * (sk_test_ = dev; sk_live_ = produção).
 *
 * Uso:
 *   npx tsx src/database/bootstrap-admin.ts --list            # lista usuários do Clerk + role no Turso
 *   npx tsx src/database/bootstrap-admin.ts <email>           # promove esse e-mail a admin
 *   npx tsx src/database/bootstrap-admin.ts <email> user      # rebaixa a user
 */
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

const SECRET = process.env.CLERK_SECRET_KEY;
if (!SECRET) {
  console.error('❌ CLERK_SECRET_KEY não configurada no .env');
  process.exit(1);
}
const CLERK_ENV = SECRET.startsWith('sk_live_') ? 'PRODUÇÃO (live)' : 'DEV/TESTE';

const db = drizzle(
  createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  }),
  { schema },
);

type ClerkUser = {
  id: string;
  email: string | null;
  name: string;
  createdAt: number;
};

async function fetchClerkUsers(): Promise<ClerkUser[]> {
  const res = await fetch(
    'https://api.clerk.com/v1/users?limit=100&order_by=-created_at',
    { headers: { Authorization: `Bearer ${SECRET}` } },
  );
  if (!res.ok) {
    throw new Error(`Clerk API retornou ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as any[];
  return raw.map((u) => {
    const primary =
      u.email_addresses?.find((e: any) => e.id === u.primary_email_address_id) ??
      u.email_addresses?.[0];
    return {
      id: u.id,
      email: primary?.email_address ?? null,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || '(sem nome)',
      createdAt: u.created_at,
    };
  });
}

async function tursoRole(id: string): Promise<string | null> {
  const [row] = await db
    .select({ role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  return row?.role ?? null;
}

async function list() {
  const users = await fetchClerkUsers();
  console.log(`Clerk [${CLERK_ENV}] — ${users.length} usuário(s):\n`);
  for (const u of users) {
    const role = await tursoRole(u.id);
    const when = new Date(u.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const flag = role === 'admin' ? '👑' : '  ';
    const turso = role ? `turso:${role}` : 'turso:(ausente)';
    console.log(`  ${flag} ${when}  ${u.email ?? '(sem e-mail)'}  ${u.name}  [${turso}]  (${u.id})`);
  }
}

async function promote(email: string, role: 'admin' | 'user') {
  const users = await fetchClerkUsers();
  const target = email.trim().toLowerCase();
  const matches = users.filter((u) => u.email?.toLowerCase() === target);

  if (matches.length === 0) {
    console.error(`❌ Nenhum usuário no Clerk [${CLERK_ENV}] com e-mail "${email}".\n`);
    await list();
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`❌ ${matches.length} usuários no Clerk com esse e-mail. Ambíguo — abortando.`);
    process.exit(1);
  }

  const u = matches[0];
  const existing = await tursoRole(u.id);

  if (existing === null) {
    // Linha ainda não existe no Turso — cria já com role e e-mail reais.
    await db.insert(schema.users).values({ id: u.id, email: u.email!, role, name: u.name });
    console.log(`✅ Criado no Turso e definido como "${role}": ${u.email} (${u.id})`);
    return;
  }

  // Atualiza role + corrige e-mail/nome placeholder com os dados reais do Clerk.
  await db
    .update(schema.users)
    .set({ role, email: u.email!, name: u.name, updatedAt: new Date() })
    .where(eq(schema.users.id, u.id));

  if (existing === role) {
    console.log(`ℹ️  ${u.email} já era "${role}" (e-mail/nome sincronizados do Clerk).`);
  } else {
    console.log(`✅ ${u.email} (${u.id}): ${existing} → ${role}`);
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === '--list') {
    await list();
    return;
  }
  const role = (process.argv[3] ?? 'admin').trim();
  if (role !== 'admin' && role !== 'user') {
    throw new Error(`Role inválida: "${role}". Use "admin" ou "user".`);
  }
  await promote(arg, role);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
