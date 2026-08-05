/**
 * Garante a coluna `position` em `listings` (idempotente e não-destrutivo):
 * a ordem escolhida pelo vendedor para a vitrine da loja. Só adiciona se ainda
 * não existir — ALTER TABLE ADD COLUMN nunca recria/perde dados.
 *
 * Uso (instância definida pelas envs do Turso):
 *   npx tsx src/database/ensure-listing-position.ts
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
  const info = await client.execute('PRAGMA table_info(listings)');
  const existing = new Set(info.rows.map((r: any) => r.name));

  if (existing.has('position')) {
    console.log('ℹ️  listings.position já existe — pulando.');
    return;
  }
  await client.execute('ALTER TABLE listings ADD COLUMN position integer');
  console.log('✅ Coluna listings.position criada.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
