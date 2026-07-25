/**
 * Colunas da emissão automática de etiqueta (Melhor Envio) em `orders`.
 *
 * Aditivas e nullable — nenhuma linha existente muda de comportamento.
 * Idempotente: só cria o que ainda não existe.
 *
 *   npx ts-node --transpile-only scripts/add-shipping-label-columns.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const COLUNAS: Array<[string, string]> = [
  ['shipping_service_id', 'integer'],
  ['shipping_service_name', 'text'],
  ['shipping_cart_id', 'text'],
  ['shipping_label_url', 'text'],
  ['shipping_label_status', 'text'],
  ['shipping_label_error', 'text'],
  ['shipping_label_at', 'integer'],
];

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);
  const info = await client.execute("PRAGMA table_info('orders')");
  const existentes = new Set((info.rows as any[]).map((r) => r.name));

  for (const [nome, tipo] of COLUNAS) {
    if (existentes.has(nome)) {
      console.log(`  = ${nome} já existe`);
      continue;
    }
    await client.execute(`ALTER TABLE orders ADD COLUMN ${nome} ${tipo}`);
    console.log(`  + ${nome} (${tipo})`);
  }

  const pendentes = await client.execute(`
    SELECT COUNT(*) AS n FROM orders
    WHERE status = 'paid'
      AND COALESCE(delivery_method, 'shipping') = 'shipping'
      AND (shipping_label_status IS NULL OR shipping_label_status != 'ready')`);
  console.log(
    `\nPedidos pagos, com envio e sem etiqueta pronta: ${pendentes.rows[0].n}`,
  );
})();
