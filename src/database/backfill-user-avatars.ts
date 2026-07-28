/**
 * Backfill das fotos de perfil usando o Clerk como fonte.
 *
 * Contexto: a API não devolvia foto do vendedor nenhuma — o selo aparecia só com
 * as iniciais no card, no perfil da loja e no anúncio, inclusive para quem tinha
 * subido foto (ela existia no Clerk e nunca chegava à vitrine). O webhook agora
 * copia a `image_url` do Clerk no cadastro e na atualização do usuário, mas isso
 * só vale para quem se cadastrar (ou mexer no perfil) daqui pra frente. Este
 * script resolve o passado.
 *
 * Só grava foto REAL: o Clerk sempre devolve uma `image_url`, e quando o usuário
 * não subiu nada ela é um avatar gerado com as iniciais dele — que não serve,
 * porque o front já desenha as iniciais sozinho. O `has_image` separa os dois.
 *
 * A foto da LOJA (`seller_profiles.avatar_url`, upload próprio) continua tendo
 * precedência na vitrine; esta aqui é o fallback.
 *
 * É idempotente: só toca em quem está sem foto no banco e tem foto no Clerk.
 *
 * A instância do Clerk é definida pela CLERK_SECRET_KEY do .env
 * (sk_test_ = dev; sk_live_ = produção). ATENÇÃO: rode com a MESMA instância
 * que emitiu os JWTs dos usuários, senão os ids não casam.
 *
 * Uso (DRY-RUN por padrão — nada é gravado):
 *   npx tsx src/database/backfill-user-avatars.ts           # mostra o que faria
 *   npx tsx src/database/backfill-user-avatars.ts --apply   # aplica
 */
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq, isNull } from 'drizzle-orm';
import * as schema from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

const APPLY = process.argv.includes('--apply');

const SECRET = process.env.CLERK_SECRET_KEY;
if (!SECRET) {
  console.error('❌ CLERK_SECRET_KEY não configurada no .env');
  process.exit(1);
}
const CLERK_ENV = SECRET.startsWith('sk_live_')
  ? 'PRODUÇÃO (live)'
  : 'DEV/TESTE';

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error('❌ TURSO_DATABASE_URL não configurada no .env');
  process.exit(1);
}

const db = drizzle(
  createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }),
  { schema },
);

/** id do Clerk → URL da foto de verdade (null quando é o avatar gerado). */
async function fetchClerkAvatars(): Promise<Map<string, string | null>> {
  const byId = new Map<string, string | null>();
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
      const temFoto = u.has_image === true;
      const foto: unknown = u.image_url ?? u.profile_image_url;
      byId.set(
        u.id,
        temFoto && typeof foto === 'string' && foto.trim() ? foto.trim() : null,
      );
    }
    if (raw.length < limit) break;
    offset += limit;
  }

  return byId;
}

async function main() {
  console.log(`Banco: ${url}`);
  console.log(`Clerk: ${CLERK_ENV}`);
  console.log(
    `Modo:  ${APPLY ? 'APLICAR (grava no banco)' : 'DRY-RUN (nada será gravado)'}\n`,
  );

  const semFoto = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(isNull(schema.users.avatarUrl));

  if (semFoto.length === 0) {
    console.log('✅ Todo mundo já tem foto no banco — nada a fazer.');
    return;
  }

  console.log(
    `${semFoto.length} usuário(s) sem foto no banco. Buscando no Clerk...\n`,
  );
  const clerk = await fetchClerkAvatars();

  let atualizados = 0;
  let semClerk = 0;
  let semFotoNoClerk = 0;

  for (const row of semFoto) {
    if (!clerk.has(row.id)) {
      semClerk++;
      continue;
    }
    const foto = clerk.get(row.id) ?? null;
    if (!foto) {
      semFotoNoClerk++;
      continue;
    }

    console.log(`  🖼️  ${row.id}  ${row.name ?? '(sem nome)'} → ${foto}`);
    if (APPLY) {
      await db
        .update(schema.users)
        .set({ avatarUrl: foto, updatedAt: new Date() })
        .where(eq(schema.users.id, row.id));
    }
    atualizados++;
  }

  console.log(
    `\nResumo: ${atualizados} ${APPLY ? 'atualizado(s)' : 'a atualizar'} | ` +
      `${semFotoNoClerk} sem foto própria no Clerk | ${semClerk} sem correspondente no Clerk.`,
  );
  if (!APPLY && atualizados > 0) {
    console.log('\n➡️  Rode novamente com --apply para gravar.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
