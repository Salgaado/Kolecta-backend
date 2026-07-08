/**
 * Garante as colunas de envio em `listings` (idempotente e não-destrutivo):
 * weight_grams, width_cm, height_cm, length_cm. Cada uma é adicionada só se
 * ainda não existir — ALTER TABLE ADD COLUMN nunca recria/perde dados.
 *
 * Uso (instância definida pelas envs do Turso):
 *   npx tsx src/database/ensure-listing-dimensions.ts
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

const COLUMNS = ['weight_grams', 'width_cm', 'height_cm', 'length_cm'];

async function main() {
  console.log(`Banco: ${url}`);
  const info = await client.execute('PRAGMA table_info(listings)');
  const existing = new Set(info.rows.map((r: any) => r.name));

  for (const col of COLUMNS) {
    if (existing.has(col)) {
      console.log(`ℹ️  listings.${col} já existe — pulando.`);
      continue;
    }
    await client.execute(`ALTER TABLE listings ADD COLUMN ${col} integer`);
    console.log(`✅ Coluna listings.${col} criada.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
