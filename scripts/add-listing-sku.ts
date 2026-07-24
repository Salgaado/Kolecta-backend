/**
 * Adiciona `listings.sku` (pendência 1 do recado do Daniel): código interno de
 * estoque do lojista. Aditivo, nullable e sem índice único — o mesmo código
 * pode se repetir entre vendedores diferentes, e a maioria não usa.
 *
 * Idempotente: só cria se ainda não existir.
 *   npx ts-node --transpile-only scripts/add-listing-sku.ts
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
  const existe = info.rows.some((r: any) => r.name === 'sku');

  if (existe) {
    console.log('ℹ️  listings.sku já existe — nada a fazer.');
  } else {
    await client.execute('ALTER TABLE listings ADD COLUMN sku text');
    console.log('✅ Coluna listings.sku criada.');
  }

  const depois = await client.execute("PRAGMA table_info('listings')");
  console.log(
    'verificação:',
    depois.rows.some((r: any) => r.name === 'sku') ? 'OK' : 'FALTA',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
