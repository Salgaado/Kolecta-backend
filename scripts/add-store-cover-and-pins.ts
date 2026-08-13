/**
 * Colunas da loja personalizada: capa (banner) e destaques da loja.
 *
 *   seller_profiles.cover_url      — imagem da capa (R2). null = sem capa.
 *   seller_profiles.cover_focal_y  — recorte vertical, 0-100. null = 50.
 *   seller_profiles.cover_overlay  — escurecimento %, 35-90. null = 55.
 *   listings.store_pinned_at       — quando o vendedor fixou no topo da loja.
 *
 * Todas aditivas e nullable, sem backfill: null é o estado de todo mundo hoje e
 * significa "loja como sempre foi".
 *
 * ── Por que um script e não `drizzle-kit push` ──────────────────────────────
 *
 * O push está QUEBRADO neste banco, e não por causa desta mudança. O índice
 * único do slug foi criado como `uq_seller_slug`, enquanto o `.unique()` do
 * schema.ts faz o drizzle esperar `seller_profiles_slug_unique`. Ele tenta
 * derrubar um índice que não existe e o batch inteiro morre:
 *
 *     LibsqlBatchError: no such index: seller_profiles_slug_unique
 *
 * Pior: para reconciliar o resto do schema, o push também gera DROP/recreate de
 * tabelas que nada têm a ver com a capa (analytics_events, 15.900 linhas). Um
 * ALTER TABLE ADD COLUMN não toca em nada além do que precisa.
 *
 * ── Obrigatório ANTES de subir o backend ────────────────────────────────────
 *
 * `/api/listings` e a vitrine da loja usam `getTableColumns(listings)`, então
 * coluna no schema.ts sem coluna no banco derruba a listagem INTEIRA com 500
 * (é o incidente de 24/07). O mesmo vale para `ensureProfile`, que faz
 * `select()` da tabela toda em `seller_profiles`.
 *
 * Idempotente: só cria o que ainda não existe.
 *   npx ts-node --transpile-only scripts/add-store-cover-and-pins.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const COLUNAS: { tabela: string; coluna: string; tipo: string }[] = [
  { tabela: 'seller_profiles', coluna: 'cover_url', tipo: 'text' },
  { tabela: 'seller_profiles', coluna: 'cover_focal_y', tipo: 'integer' },
  { tabela: 'seller_profiles', coluna: 'cover_overlay', tipo: 'integer' },
  { tabela: 'listings', coluna: 'store_pinned_at', tipo: 'integer' },
];

async function colunasDe(tabela: string): Promise<string[]> {
  const info = await client.execute(`PRAGMA table_info('${tabela}')`);
  return info.rows.map((r: any) => r.name as string);
}

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}\n`);

  for (const { tabela, coluna, tipo } of COLUNAS) {
    const existentes = await colunasDe(tabela);
    if (existentes.includes(coluna)) {
      console.log(`ℹ️  ${tabela}.${coluna} já existe, nada a fazer.`);
      continue;
    }
    await client.execute(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
    console.log(`✅ ${tabela}.${coluna} criada (${tipo}).`);
  }

  console.log('\nverificação:');
  let faltando = 0;
  for (const { tabela, coluna } of COLUNAS) {
    const ok = (await colunasDe(tabela)).includes(coluna);
    if (!ok) faltando++;
    console.log(`  ${ok ? 'OK  ' : 'FALTA'} ${tabela}.${coluna}`);
  }
  process.exit(faltando ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
