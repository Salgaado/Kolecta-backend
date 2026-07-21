/**
 * Auditoria (READ-ONLY) — anúncios ATIVOS que não passam na peneira de publicação.
 * Usa a MESMA regra do backend (`listing-publish-rules`). Não altera nada.
 *
 * Uso: npx ts-node --transpile-only scripts/audit-listings-conformity.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import {
  listingPublishBlockers,
  type ListingPublishFields,
} from '../src/listings/listing-publish-rules';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const res = await client.execute(`
    select l.id, l.title, l.seller_id, l.type, l.description, l.price_in_cents,
           l.images, l.category_id, l.condition,
           l.weight_grams, l.width_cm, l.height_cm, l.length_cm,
           a.starting_bid_in_cents as starting_bid,
           u.name as seller_name, u.email as seller_email
    from listings l
    left join auctions a on a.listing_id = l.id
    left join users u on u.id = l.seller_id
    where l.status = 'active'
  `);

  const rows = res.rows as any[];
  type NC = { id: string; title: string; missing: string[] };
  const bySeller = new Map<
    string,
    { name: string; email: string; items: NC[] }
  >();
  const reasonCount = new Map<string, number>();
  let conforming = 0;

  for (const r of rows) {
    const listing: ListingPublishFields = {
      type: r.type,
      description: r.description,
      priceInCents: r.price_in_cents,
      images: r.images,
      categoryId: r.category_id,
      condition: r.condition,
      weightGrams: r.weight_grams,
      widthCm: r.width_cm,
      heightCm: r.height_cm,
      lengthCm: r.length_cm,
    };
    const missing = listingPublishBlockers(listing, r.starting_bid);
    if (missing.length === 0) {
      conforming++;
      continue;
    }
    for (const m of missing) reasonCount.set(m, (reasonCount.get(m) ?? 0) + 1);
    const key = String(r.seller_id);
    if (!bySeller.has(key)) {
      bySeller.set(key, {
        name: r.seller_name ?? '(sem nome)',
        email: r.seller_email ?? '(sem email)',
        items: [],
      });
    }
    bySeller.get(key)!.items.push({
      id: String(r.id),
      title: String(r.title),
      missing,
    });
  }

  const nonConforming = rows.length - conforming;
  console.log('═══════════════════════════════════════════════');
  console.log(`Anúncios ATIVOS: ${rows.length}`);
  console.log(`  ✅ conformes: ${conforming}`);
  console.log(`  ❌ NÃO conformes: ${nonConforming}  (vendedores afetados: ${bySeller.size})`);
  console.log('═══════════════════════════════════════════════');

  console.log('\n── Motivos mais comuns ──');
  [...reasonCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, n]) => console.log(`  ${n}×  ${reason}`));

  console.log('\n── Por vendedor ──');
  for (const [sellerId, s] of bySeller) {
    console.log(`\n• ${s.name} <${s.email}>  (${sellerId})  — ${s.items.length} anúncio(s)`);
    for (const it of s.items) {
      console.log(`    [${it.id.slice(0, 8)}] ${it.title}`);
      console.log(`        falta: ${it.missing.join('; ')}`);
    }
  }
})().catch((e: any) => {
  console.error('Falhou:', e?.message);
  process.exit(1);
});
