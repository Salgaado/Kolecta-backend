/**
 * Adiciona `listings.paused_by_stock`: quem pausou o anúncio foi a falta de
 * estoque, e não a mão do vendedor?
 *
 * Sem essa distinção a sincronização com o Bling não tem como repor: `paused`
 * sozinho não diz se o anúncio saiu do ar porque zerou ou porque o vendedor
 * tirou de propósito. Sem a marca, o ERP republicaria justamente o que ele
 * decidiu esconder da vitrine.
 *
 * Aditivo e nullable. null = não foi o estoque, que é o certo para todo mundo
 * hoje: quem está pausado agora ou foi pausado à mão, ou zerou antes desta
 * marca existir, e nesse segundo caso a reativação continua sendo manual, como
 * já era. Não precisa de backfill.
 *
 * Obrigatório ANTES de subir o backend: várias consultas fazem `select()` da
 * tabela inteira, então a coluna no schema.ts sem a coluna no banco derruba as
 * rotas de anúncio com 500.
 *
 * Idempotente: só cria se ainda não existir.
 *   npx ts-node --transpile-only scripts/add-listing-paused-by-stock.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);
  const info = await client.execute("PRAGMA table_info('listings')");
  const existe = info.rows.some((r: any) => r.name === 'paused_by_stock');

  if (existe) {
    console.log('ℹ️  listings.paused_by_stock já existe, nada a fazer.');
  } else {
    await client.execute(
      'ALTER TABLE listings ADD COLUMN paused_by_stock integer DEFAULT 0',
    );
    console.log('✅ Coluna listings.paused_by_stock criada.');
  }

  const depois = await client.execute("PRAGMA table_info('listings')");
  console.log(
    'verificação:',
    depois.rows.some((r: any) => r.name === 'paused_by_stock') ? 'OK' : 'FALTA',
  );

  const pausados = await client.execute(
    "SELECT COUNT(*) AS n FROM listings WHERE status = 'paused'",
  );
  const vinculados = await client.execute(
    'SELECT COUNT(*) AS n FROM listings WHERE bling_product_id IS NOT NULL',
  );
  console.log(
    `contexto: ${(pausados.rows[0] as any).n} pausado(s), ` +
      `${(vinculados.rows[0] as any).n} anúncio(s) ligado(s) ao Bling.`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
