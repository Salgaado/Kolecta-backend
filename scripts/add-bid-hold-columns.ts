/**
 * Colunas do teto de autorizações por lance (`bids`). Aditivas.
 *
 * `hold_attempts` é o que impede o cron de martelar o cartão de um comprador:
 * conta toda tentativa de criar retenção para o lance e para de vez ao bater o
 * teto. Nasce em 0 para os lances que já existem — nenhum deles tem retenção a
 * armar (leilão encerrado), então o valor inicial não muda nada.
 *
 * `drizzle-kit push` está quebrado neste projeto (propõe DROP de tabela viva),
 * por isso o ALTER na mão. Ver memória `drizzle-push-quebrado`.
 *
 *   npx ts-node --transpile-only scripts/add-bid-hold-columns.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const info = await client.execute("PRAGMA table_info('bids')");
  const existentes = new Set((info.rows as any[]).map((r) => r.name));
  for (const [nome, tipo] of [
    ['hold_attempts', 'integer NOT NULL DEFAULT 0'],
    ['hold_last_error', 'text'],
    ['hold_next_attempt_at', 'integer'],
    ['hold_checked_at', 'integer'],
  ] as Array<[string, string]>) {
    if (existentes.has(nome)) {
      console.log(`  = ${nome} já existe`);
      continue;
    }
    await client.execute(`ALTER TABLE bids ADD COLUMN ${nome} ${tipo}`);
    console.log(`  + ${nome}`);
  }
  console.log('pronto.');
})();
