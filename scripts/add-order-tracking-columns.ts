/**
 * Adiciona as colunas de rastreio do envio em `orders`:
 *   tracking_status, shipping_posted_at, shipping_delivered_at, tracking_checked_at
 *
 * São os marcos do /me/shipment/tracking, guardados para a tela ler rápido e
 * para o cron detectar a entrega sem repuxar o Melhor Envio a cada acesso.
 *
 * Aditivas e nullable. null = ainda não rastreado, que é o certo para todos os
 * pedidos de hoje. Não precisa de backfill.
 *
 * Obrigatório ANTES de subir o backend: várias consultas fazem `select()` da
 * tabela orders inteira, então uma coluna no schema.ts sem a coluna no banco
 * derruba as rotas de pedido com 500.
 *
 * Idempotente: só cria a que faltar.
 *   npx ts-node --transpile-only scripts/add-order-tracking-columns.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const COLUNAS: Array<{ nome: string; ddl: string }> = [
  { nome: 'tracking_status', ddl: 'ALTER TABLE orders ADD COLUMN tracking_status text' },
  { nome: 'shipping_posted_at', ddl: 'ALTER TABLE orders ADD COLUMN shipping_posted_at integer' },
  { nome: 'shipping_delivered_at', ddl: 'ALTER TABLE orders ADD COLUMN shipping_delivered_at integer' },
  { nome: 'tracking_checked_at', ddl: 'ALTER TABLE orders ADD COLUMN tracking_checked_at integer' },
];

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);
  const info = await client.execute("PRAGMA table_info('orders')");
  const existentes = new Set((info.rows as any[]).map((r) => r.name));

  for (const c of COLUNAS) {
    if (existentes.has(c.nome)) {
      console.log(`ℹ️  orders.${c.nome} já existe.`);
    } else {
      await client.execute(c.ddl);
      console.log(`✅ Coluna orders.${c.nome} criada.`);
    }
  }

  const depois = await client.execute("PRAGMA table_info('orders')");
  const agora = new Set((depois.rows as any[]).map((r) => r.name));
  const faltando = COLUNAS.filter((c) => !agora.has(c.nome)).map((c) => c.nome);
  console.log('verificação:', faltando.length === 0 ? 'OK, todas presentes' : `FALTA ${faltando.join(', ')}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
