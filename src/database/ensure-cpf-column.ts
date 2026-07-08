/**
 * Garante a coluna `users.cpf` no banco (idempotente e não-destrutivo).
 * ALTER TABLE ADD COLUMN só adiciona — nunca recria/perde dados.
 *
 * Uso (instância definida pelas envs do Turso):
 *   npx tsx src/database/ensure-cpf-column.ts
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
  const info = await client.execute('PRAGMA table_info(users)');
  const hasCpf = info.rows.some((r: any) => r.name === 'cpf');

  if (hasCpf) {
    console.log('ℹ️  Coluna users.cpf já existe — nada a fazer.');
    return;
  }

  await client.execute('ALTER TABLE users ADD COLUMN cpf text');
  console.log('✅ Coluna users.cpf criada.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
