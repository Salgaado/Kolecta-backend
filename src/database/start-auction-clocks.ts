/**
 * Inicia o relógio (endsAt) de leilões cujo anúncio já está `active` mas que
 * ficaram com `endsAt = null` — caso dos leilões criados por backfill quando o
 * anúncio já estava ativo (o auto-start só dispara na transição para active).
 *
 * Idempotente: só toca leilões com endsAt null e listing active. Define
 * endsAt = agora + durationHours.
 *
 * Uso (instância vem das envs do Turso):
 *   npx tsx src/database/start-auction-clocks.ts --dry   # só mostra
 *   npx tsx src/database/start-auction-clocks.ts         # aplica
 */
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

const DRY = process.argv.includes('--dry');
const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error('❌ TURSO_DATABASE_URL não configurada.');
  process.exit(1);
}
console.log(`Banco: ${url}\nModo: ${DRY ? 'DRY-RUN (nada será gravado)' : 'APLICAR'}\n`);

const db = drizzle(
  createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }),
  { schema },
);

async function main() {
  // Leilões parados (endsAt null) cujo anúncio está ativo.
  const rows = await db
    .select({
      auctionId: schema.auctions.id,
      durationHours: schema.auctions.durationHours,
      title: schema.listings.title,
    })
    .from(schema.auctions)
    .innerJoin(schema.listings, eq(schema.auctions.listingId, schema.listings.id))
    .where(
      and(isNull(schema.auctions.endsAt), eq(schema.listings.status, 'active')),
    );

  console.log(`Leilões ativos com relógio parado: ${rows.length}`);
  let started = 0;

  for (const r of rows) {
    const endsAt = new Date(Date.now() + (r.durationHours ?? 48) * 60 * 60 * 1000);
    console.log(
      `  ${DRY ? '[dry] ' : '▶️ '}${r.title} — inicia (termina em ${endsAt.toISOString()})`,
    );
    if (!DRY) {
      await db
        .update(schema.auctions)
        .set({ endsAt, status: 'active', updatedAt: new Date() })
        .where(eq(schema.auctions.id, r.auctionId));
      started++;
    }
  }

  console.log(`\n${DRY ? 'Seriam iniciados' : 'Iniciados'}: ${started} leilão(ões).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
