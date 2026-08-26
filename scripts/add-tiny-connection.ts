/**
 * Cria `tiny_connections` e `listings.tiny_product_id` — a integração com o
 * Tiny (Olist ERP), o segundo ERP do vendedor. Ver docs/PLAN-tiny-olist.md.
 *
 * Espelha o que já existe para o Bling, e pelos mesmos motivos:
 *
 * - `tiny_connections` guarda os tokens OAuth por vendedor. `user_id` é UNIQUE
 *   porque uma conta da Kolecta liga em uma conta do Tiny; conectar de novo
 *   sobrescreve em vez de acumular linha morta com token velho.
 * - `listings.tiny_product_id` é o elo entre o anúncio e o produto no ERP. Sem
 *   ele, reimportar duplicaria o anúncio e sincronizar estoque seria impossível.
 * - O índice parcial impede que o mesmo produto do Tiny vire dois anúncios do
 *   mesmo vendedor. Não é único global de propósito: dois VENDEDORES podem ter
 *   o produto de id 42 nos Tinys deles, que são bancos separados.
 *
 * NÃO guarda `client_id`/`client_secret`. Se a Olist confirmar que cada lojista
 * gera as próprias credenciais (Caminho A do plano), elas entram em um segundo
 * script, criptografadas.
 *
 * Obrigatório ANTES de subir o backend com o schema novo: a listagem de
 * anúncios faz select da tabela inteira (`getTableColumns`), então coluna no
 * schema.ts sem coluna no banco derruba /api/listings com 500 — já aconteceu.
 *
 * `drizzle-kit push` NÃO serve aqui: ele ainda propõe dropar `analytics_events`
 * e briga com o nome do índice de slug. Por isso este script.
 *
 * Idempotente: só cria o que ainda não existe.
 *   npx ts-node --transpile-only scripts/add-tiny-connection.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const DDL = `
CREATE TABLE tiny_connections (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
)`;

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);

  // ── 1. Tabela de conexões ──────────────────────────────────────────────────

  const tabelas = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tiny_connections'",
  );

  if (tabelas.rows.length > 0) {
    console.log('ℹ️  tiny_connections já existe, nada a fazer.');
  } else {
    await client.execute(DDL);
    console.log('✅ Tabela tiny_connections criada.');
  }

  // ── 2. Coluna do elo no anúncio ────────────────────────────────────────────

  const info = await client.execute("PRAGMA table_info('listings')");
  if (info.rows.some((r: any) => r.name === 'tiny_product_id')) {
    console.log('ℹ️  listings.tiny_product_id já existe, nada a fazer.');
  } else {
    await client.execute(
      'ALTER TABLE listings ADD COLUMN tiny_product_id integer',
    );
    console.log('✅ Coluna listings.tiny_product_id criada.');
  }

  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_tiny_produto
       ON listings (seller_id, tiny_product_id)
     WHERE tiny_product_id IS NOT NULL`,
  );
  console.log('✅ Índice uq_listing_tiny_produto garantido.');

  // ── 3. Verificação ─────────────────────────────────────────────────────────

  const colunas = await client.execute("PRAGMA table_info('tiny_connections')");
  console.log('\nColunas de tiny_connections:');
  colunas.rows.forEach((r: any) => console.log(`  ${r.name} ${r.type}`));

  const depois = await client.execute("PRAGMA table_info('listings')");
  const idx = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_listing_tiny_produto'",
  );
  console.log(
    '\nverificação: listings.tiny_product_id',
    depois.rows.some((r: any) => r.name === 'tiny_product_id') ? 'OK' : 'FALTA',
    '| índice',
    idx.rows.length ? 'OK' : 'FALTA',
  );

  const n = await client.execute('SELECT COUNT(*) AS n FROM tiny_connections');
  console.log(`conexões Tiny hoje: ${n.rows[0].n}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
