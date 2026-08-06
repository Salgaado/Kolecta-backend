/**
 * Cria a tabela `analytics_events` (idempotente): o funil de trafego proprio do
 * painel. Sem dados sensiveis (sessao anonima gerada no cliente).
 *
 * Uso: npx tsx src/database/ensure-analytics-events.ts
 */
import { createClient } from '@libsql/client';
import * as dotenv from 'dotenv';

dotenv.config();

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error('❌ TURSO_DATABASE_URL não configurada.');
  process.exit(1);
}
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

async function main() {
  console.log(`Banco: ${url}`);
  await client.execute(`CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id TEXT,
    event TEXT NOT NULL,
    path TEXT,
    listing_id TEXT,
    meta TEXT,
    created_at INTEGER NOT NULL
  )`);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS analytics_events_created_idx ON analytics_events (created_at)`,
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS analytics_events_session_event_idx ON analytics_events (session_id, event)`,
  );
  console.log('✅ Tabela analytics_events e índices prontos.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
