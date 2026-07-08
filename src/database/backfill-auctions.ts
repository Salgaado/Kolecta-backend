/**
 * Backfill: cria a linha de `auctions` (parada) para anúncios `type='auction'`
 * criados ANTES do fix de leilão (que não geravam a linha). Usa o `priceInCents`
 * do listing como lance inicial (era onde o wizard antigo guardava o startingBid).
 *
 * Idempotente: pula anúncios que já têm leilão. O relógio (`endsAt`) fica null —
 * começa quando o admin ativar o anúncio (ListingsService.updateStatus).
 *
 * Uso (a instância vem das envs do Turso):
 *   npx tsx src/database/backfill-auctions.ts          # aplica
 *   npx tsx src/database/backfill-auctions.ts --dry    # só mostra o que faria
 */
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq, and } from 'drizzle-orm';
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
  const auctionListings = await db
    .select()
    .from(schema.listings)
    .where(eq(schema.listings.type, 'auction'));

  console.log(`Anúncios type='auction': ${auctionListings.length}`);
  let created = 0;

  for (const l of auctionListings) {
    const [existing] = await db
      .select({ id: schema.auctions.id })
      .from(schema.auctions)
      .where(eq(schema.auctions.listingId, l.id))
      .limit(1);

    if (existing) {
      console.log(`  ⏭️  ${l.title} — já tem leilão (${existing.id})`);
      continue;
    }

    const startingBidInCents = l.priceInCents ?? 0;
    console.log(
      `  ${DRY ? '[dry] ' : '➕ '}${l.title} — criar leilão parado (lance inicial R$${(startingBidInCents / 100).toFixed(2)})${startingBidInCents === 0 ? ' ⚠️ sem preço, lance inicial 0' : ''}`,
    );

    if (!DRY) {
      await db.insert(schema.auctions).values({
        listingId: l.id,
        startingBidInCents,
        minIncrementInCents: 1000,
        durationHours: 48,
        status: 'active',
        // endsAt omitido = null → parado até a ativação pelo admin
      });
      created++;
    }
  }

  console.log(`\n${DRY ? 'Seriam criados' : 'Criados'}: ${created} leilão(ões).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
