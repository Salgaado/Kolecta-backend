/**
 * Adiciona `listings.stock`. Aditiva e nullable.
 * O front já mandava o campo e o backend descartava.
 *   npx ts-node --transpile-only scripts/add-listing-stock.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const info = await client.execute("PRAGMA table_info('listings')");
  if ((info.rows as any[]).some((r) => r.name === 'stock')) {
    console.log('listings.stock já existe.');
    return;
  }
  await client.execute('ALTER TABLE listings ADD COLUMN stock integer');
  console.log('listings.stock criada.');
})();
