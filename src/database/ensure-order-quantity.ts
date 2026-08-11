/**
 * Garante a coluna `orders.quantity` no banco (idempotente e não-destrutivo).
 * ALTER TABLE ADD COLUMN só adiciona — nunca recria/perde dados. Pedidos antigos
 * ficam com o default 1.
 *
 * Uso (instância definida pelas envs do Turso):
 *   npx tsx src/database/ensure-order-quantity.ts
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
  const info = await client.execute('PRAGMA table_info(orders)');
  const has = info.rows.some((r: any) => r.name === 'quantity');

  if (has) {
    console.log('ℹ️  Coluna orders.quantity já existe — nada a fazer.');
    return;
  }

  await client.execute(
    'ALTER TABLE orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1',
  );
  console.log('✅ Coluna orders.quantity criada (default 1).');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
