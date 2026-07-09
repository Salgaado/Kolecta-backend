/**
 * Backfill dos usuários "placeholder" usando o Clerk como fonte de verdade.
 *
 * Contexto: quando o webhook `user.created` do Clerk não dispara, o
 * `UsersService.findOrCreate` auto-provisiona a linha e — se o `fetchClerkUser`
 * falhar — grava `name = "Novo Usuário"` e `email = <id>@placeholder.kolecta`.
 * Resultado: anúncios exibem "Novo Usuário" + o id Clerk em vez do nome real.
 *
 * Este script lista os usuários reais direto da API do Clerk (casando pelo id,
 * que é o mesmo `users.id` no Turso) e corrige `name`/`email` de TODAS as linhas
 * placeholder — não só admins (diferente do `bootstrap-admin.ts`).
 *
 * É idempotente: só toca linhas cujo nome/e-mail ainda estão em placeholder e
 * para as quais o Clerk tem dado real. Nunca sobrescreve com "(sem nome)".
 *
 * A instância do Clerk é definida pela CLERK_SECRET_KEY do .env
 * (sk_test_ = dev; sk_live_ = produção). ATENÇÃO: rode com a MESMA instância
 * que emitiu os JWTs dos usuários, senão os ids não casam.
 *
 * Uso (DRY-RUN por padrão — nada é gravado):
 *   npx tsx src/database/backfill-user-names.ts           # mostra o que faria
 *   npx tsx src/database/backfill-user-names.ts --apply    # aplica as correções
 */
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq, like, or } from 'drizzle-orm';
import * as schema from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

const APPLY = process.argv.includes('--apply');

const SECRET = process.env.CLERK_SECRET_KEY;
if (!SECRET) {
  console.error('❌ CLERK_SECRET_KEY não configurada no .env');
  process.exit(1);
}
const CLERK_ENV = SECRET.startsWith('sk_live_') ? 'PRODUÇÃO (live)' : 'DEV/TESTE';

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error('❌ TURSO_DATABASE_URL não configurada no .env');
  process.exit(1);
}

const db = drizzle(createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }), { schema });

const PLACEHOLDER_NAME = 'Novo Usuário';
const PLACEHOLDER_EMAIL_SUFFIX = '@placeholder.kolecta';

type ClerkUser = { id: string; email: string | null; name: string };

/** Busca todos os usuários do Clerk (paginado). */
async function fetchClerkUsers(): Promise<Map<string, ClerkUser>> {
  const byId = new Map<string, ClerkUser>();
  const limit = 100;
  let offset = 0;

  for (;;) {
    const res = await fetch(
      `https://api.clerk.com/v1/users?limit=${limit}&offset=${offset}&order_by=-created_at`,
      { headers: { Authorization: `Bearer ${SECRET}` } },
    );
    if (!res.ok) {
      throw new Error(`Clerk API retornou ${res.status}: ${await res.text()}`);
    }
    const raw = (await res.json()) as any[];
    for (const u of raw) {
      const primary =
        u.email_addresses?.find((e: any) => e.id === u.primary_email_address_id) ??
        u.email_addresses?.[0];
      byId.set(u.id, {
        id: u.id,
        email: primary?.email_address ?? null,
        name: [u.first_name, u.last_name].filter(Boolean).join(' ') || '',
      });
    }
    if (raw.length < limit) break;
    offset += limit;
  }

  return byId;
}

async function main() {
  console.log(`Banco: ${url}`);
  console.log(`Clerk: ${CLERK_ENV}`);
  console.log(`Modo:  ${APPLY ? 'APLICAR (grava no banco)' : 'DRY-RUN (nada será gravado)'}\n`);

  // Linhas placeholder no Turso: nome placeholder OU e-mail placeholder.
  const placeholders = await db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(
      or(
        eq(schema.users.name, PLACEHOLDER_NAME),
        like(schema.users.email, `%${PLACEHOLDER_EMAIL_SUFFIX}`),
      ),
    );

  if (placeholders.length === 0) {
    console.log('✅ Nenhuma linha placeholder encontrada — nada a fazer.');
    return;
  }

  console.log(`Encontradas ${placeholders.length} linha(s) placeholder. Buscando no Clerk...\n`);
  const clerk = await fetchClerkUsers();

  let updated = 0;
  let skippedNoClerk = 0;
  let skippedNoData = 0;

  for (const row of placeholders) {
    const c = clerk.get(row.id);

    if (!c) {
      console.log(`  ⏭️  ${row.id}  — sem correspondente no Clerk [${CLERK_ENV}] (deletado ou instância errada)`);
      skippedNoClerk++;
      continue;
    }

    // Só corrige o que o Clerk tem de verdade; não sobrescreve com vazio.
    const nextName = c.name || null; // null = mantém o atual
    const nextEmail = c.email && !c.email.endsWith(PLACEHOLDER_EMAIL_SUFFIX) ? c.email : null;

    const set: { name?: string; email?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (nextName && nextName !== row.name) set.name = nextName;
    if (nextEmail && nextEmail !== row.email) set.email = nextEmail;

    if (set.name === undefined && set.email === undefined) {
      console.log(`  ⏭️  ${row.id}  — Clerk não tem nome/e-mail melhores (name="${c.name}" email="${c.email}")`);
      skippedNoData++;
      continue;
    }

    const before = `name="${row.name}" email="${row.email}"`;
    const after = `name="${set.name ?? row.name}" email="${set.email ?? row.email}"`;
    console.log(`  ✏️  ${row.id}\n        de:   ${before}\n        para: ${after}`);

    if (APPLY) {
      await db.update(schema.users).set(set).where(eq(schema.users.id, row.id));
    }
    updated++;
  }

  console.log(
    `\nResumo: ${updated} ${APPLY ? 'atualizada(s)' : 'a atualizar'} | ` +
      `${skippedNoClerk} sem Clerk | ${skippedNoData} sem dado melhor.`,
  );
  if (!APPLY && updated > 0) {
    console.log('\n➡️  Rode novamente com --apply para gravar.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
