/**
 * Garante a coluna `seller_profiles.slug` + índice único, e faz BACKFILL: gera
 * um slug único (do store_name, senão do nome do usuário) para cada loja que
 * ainda não tem. Idempotente e não-destrutivo (só preenche o que está vazio).
 *
 * Uso:
 *   npx tsx src/database/ensure-seller-slug.ts
 */
import { createClient } from '@libsql/client';
import * as dotenv from 'dotenv';
import { slugUnico } from '../common/slug';

dotenv.config();

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error('❌ TURSO_DATABASE_URL não configurada.');
  process.exit(1);
}
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

async function main() {
  console.log(`Banco: ${url}`);

  const info = await client.execute('PRAGMA table_info(seller_profiles)');
  const temColuna = info.rows.some((r: any) => r.name === 'slug');
  if (!temColuna) {
    await client.execute('ALTER TABLE seller_profiles ADD COLUMN slug text');
    console.log('✅ Coluna seller_profiles.slug criada.');
  } else {
    console.log('ℹ️  Coluna slug já existe.');
  }

  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_slug ON seller_profiles(slug)',
  );

  // Slugs já ocupados (para o backfill não colidir).
  const jaTem = await client.execute(
    "SELECT slug FROM seller_profiles WHERE slug IS NOT NULL AND slug <> ''",
  );
  const usados = new Set<string>(jaTem.rows.map((r: any) => String(r.slug)));

  // Lojas sem slug: pega store_name e, na falta, o nome do usuário.
  const semSlug = await client.execute(`
    SELECT sp.user_id AS userId,
           COALESCE(NULLIF(TRIM(sp.store_name),''), NULLIF(TRIM(u.name),'')) AS nome
    FROM seller_profiles sp
    JOIN users u ON u.id = sp.user_id
    WHERE sp.slug IS NULL OR sp.slug = ''
  `);

  let feitos = 0;
  for (const row of semSlug.rows as any[]) {
    const slug = slugUnico(row.nome, usados);
    usados.add(slug);
    await client.execute({
      sql: 'UPDATE seller_profiles SET slug = ? WHERE user_id = ?',
      args: [slug, row.userId],
    });
    feitos++;
  }

  console.log(`✅ Backfill: ${feitos} slug(s) gerado(s). Total ocupados: ${usados.size}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
