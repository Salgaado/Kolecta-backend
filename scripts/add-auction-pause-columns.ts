/**
 * Colunas de pausa de leilão. Aditivas e nullable.
 *   npx ts-node --transpile-only scripts/add-auction-pause-columns.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const info = await client.execute("PRAGMA table_info('auctions')");
  const existentes = new Set((info.rows as any[]).map((r) => r.name));
  for (const [nome, tipo] of [
    ['paused_at', 'integer'],
    ['paused_remaining_ms', 'integer'],
  ] as Array<[string, string]>) {
    if (existentes.has(nome)) {
      console.log(`  = ${nome} já existe`);
      continue;
    }
    await client.execute(`ALTER TABLE auctions ADD COLUMN ${nome} ${tipo}`);
    console.log(`  + ${nome}`);
  }
})();
