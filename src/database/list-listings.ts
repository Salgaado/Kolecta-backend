/**
 * Lista anúncios do banco por status (read-only) — útil para o admin saber o
 * que há para ativar. A instância é definida pelas envs do Turso.
 *
 * Uso (produção):
 *   $env:TURSO_DATABASE_URL='libsql://kolecta-prod-...'; `
 *   $env:TURSO_AUTH_TOKEN='...'; `
 *   npx tsx src/database/list-listings.ts
 *
 * Uso (dev): npx tsx src/database/list-listings.ts   (usa o .env local)
 */
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { sql, inArray, desc } from 'drizzle-orm';
import * as schema from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error('❌ TURSO_DATABASE_URL não configurada.');
  process.exit(1);
}
const isProd = !url.includes('local') && !url.startsWith('file:');
console.log(`Banco: ${url}  [${isProd ? 'remoto' : 'local'}]\n`);

const db = drizzle(
  createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }),
  { schema },
);

async function main() {
  // Contagem por status
  const counts = await db
    .select({
      status: schema.listings.status,
      total: sql<number>`count(*)`,
    })
    .from(schema.listings)
    .groupBy(schema.listings.status);

  if (counts.length === 0) {
    console.log('Nenhum anúncio cadastrado no banco.');
    return;
  }

  console.log('Anúncios por status:');
  for (const c of counts) {
    console.log(`  ${String(c.status).padEnd(16)} ${c.total}`);
  }

  // Detalhe dos pendentes de ativação
  const pending = await db
    .select({
      id: schema.listings.id,
      title: schema.listings.title,
      status: schema.listings.status,
      type: schema.listings.type,
      priceInCents: schema.listings.priceInCents,
      sellerId: schema.listings.sellerId,
      createdAt: schema.listings.createdAt,
    })
    .from(schema.listings)
    .where(inArray(schema.listings.status, ['draft', 'pending_review']))
    .orderBy(desc(schema.listings.createdAt));

  console.log(`\nPendentes de ativação (draft/pending_review): ${pending.length}`);
  for (const l of pending) {
    const price =
      l.priceInCents != null ? `R$${(l.priceInCents / 100).toFixed(2)}` : '—';
    const when = l.createdAt
      ? new Date(l.createdAt).toISOString().slice(0, 16).replace('T', ' ')
      : '?';
    console.log(
      `  ${when}  [${l.status}/${l.type}]  ${price.padEnd(10)}  ${l.title}  (${l.id})  seller:${l.sellerId}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
