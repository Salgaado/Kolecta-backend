/**
 * Adiciona `listings.bling_product_id`: o elo entre o anúncio na Kolecta e o
 * produto no Bling do vendedor.
 *
 * Sem ele não dá para saber que os dois são a mesma coisa: reimportar duplicaria
 * o anúncio, e sincronizar estoque seria impossível.
 *
 * Aditivo e nullable. null = anúncio criado na Kolecta, que é o caso de todos
 * os 1.027 ativos hoje. Não precisa de backfill.
 *
 * Índice parcial (só onde não é null) garante que um produto do Bling não vire
 * dois anúncios. Não é único global de propósito: dois VENDEDORES diferentes
 * podem ter o produto de id 42 nos Blings deles, que são bancos separados.
 *
 * Obrigatório ANTES de subir o backend: a listagem de anúncios faz select da
 * tabela inteira, então a coluna no schema.ts sem a coluna no banco derruba
 * /api/listings com 500 (já aconteceu).
 *
 * Idempotente: só cria o que ainda não existe.
 *   npx ts-node --transpile-only scripts/add-listing-bling-product-id.ts
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
  if (info.rows.some((r: any) => r.name === 'bling_product_id')) {
    console.log('ℹ️  listings.bling_product_id já existe, nada a fazer.');
  } else {
    await client.execute(
      'ALTER TABLE listings ADD COLUMN bling_product_id integer',
    );
    console.log('✅ Coluna listings.bling_product_id criada.');
  }

  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_bling_produto
       ON listings (seller_id, bling_product_id)
     WHERE bling_product_id IS NOT NULL`,
  );
  console.log('✅ Índice uq_listing_bling_produto garantido.');

  const depois = await client.execute("PRAGMA table_info('listings')");
  const idx = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_listing_bling_produto'",
  );
  console.log(
    'verificação: coluna',
    depois.rows.some((r: any) => r.name === 'bling_product_id') ? 'OK' : 'FALTA',
    '| índice',
    idx.rows.length ? 'OK' : 'FALTA',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
