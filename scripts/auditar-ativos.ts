/**
 * Audita os anúncios ATIVOS contra a peneira de publicação real
 * (`listingPublishBlockers`), a mesma função que o backend usa. Não reimplementa
 * as regras: se a peneira mudar, esta auditoria acompanha sozinha.
 *
 * Os ativos de hoje foram TODOS auto-publicados (moderated_by nulo) antes de a
 * peneira existir, então nunca passaram por essa régua.
 *
 * Só leitura. Para a ação, ver `--mover` em despublicar-incompletos.ts.
 *   npx ts-node --transpile-only scripts/auditar-ativos.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { listingPublishBlockers } from '../src/listings/listing-publish-rules';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const cats = await client.execute('SELECT id, slug FROM categories');
  const slugById = new Map(
    (cats.rows as any[]).map((c) => [c.id, c.slug as string]),
  );

  const rows = (
    await client.execute(`
      SELECT l.*, COALESCE(u.name,'?') AS seller_name, u.email AS seller_email
        FROM listings l LEFT JOIN users u ON u.id = l.seller_id
       WHERE l.status = 'active'
       ORDER BY u.name, l.title`)
  ).rows as any[];

  // Leilão: a peneira precisa do lance inicial e da reserva.
  const auctions = (
    await client.execute(
      'SELECT listing_id, starting_bid_in_cents, reserve_price_in_cents FROM auctions',
    )
  ).rows as any[];
  const auctionByListing = new Map(auctions.map((a) => [a.listing_id, a]));

  const problemas: Array<{
    id: string;
    titulo: string;
    vendedor: string;
    faltas: string[];
  }> = [];

  for (const r of rows) {
    const auc = auctionByListing.get(r.id);
    const faltas = listingPublishBlockers(
      {
        type: r.type,
        title: r.title,
        description: r.description,
        priceInCents: r.price_in_cents,
        images: r.images,
        categoryId: r.category_id,
        condition: r.condition,
        weightGrams: r.weight_grams,
        widthCm: r.width_cm,
        heightCm: r.height_cm,
        lengthCm: r.length_cm,
        brand: r.brand,
        line: r.line,
        scale: r.scale,
        attributes: r.attributes,
      },
      auc?.starting_bid_in_cents ?? null,
      {
        reservePriceInCents: auc?.reserve_price_in_cents ?? null,
        categorySlug: slugById.get(r.category_id) ?? null,
      },
    );

    if (faltas.length > 0) {
      problemas.push({
        id: r.id,
        titulo: r.title,
        vendedor: r.seller_name,
        faltas,
      });
    }
  }

  console.log(`\nAnúncios ATIVOS: ${rows.length}`);
  console.log(`  passam na peneira : ${rows.length - problemas.length}`);
  console.log(`  com pendência     : ${problemas.length}\n`);

  if (problemas.length === 0) return;

  // Ranking do que mais falta — mostra onde está o problema de verdade.
  const contagem = new Map<string, number>();
  for (const p of problemas)
    for (const f of p.faltas) contagem.set(f, (contagem.get(f) ?? 0) + 1);

  console.log('=== o que falta (todos os anúncios com pendência) ===');
  for (const [falta, n] of [...contagem.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(3)}x  ${falta}`);

  console.log('\n=== por vendedor ===');
  const porVendedor = new Map<string, number>();
  for (const p of problemas)
    porVendedor.set(p.vendedor, (porVendedor.get(p.vendedor) ?? 0) + 1);
  for (const [v, n] of [...porVendedor.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(3)}  ${v}`);

  console.log('\n=== detalhe ===');
  for (const p of problemas) {
    console.log(`\n• ${p.titulo.slice(0, 62)}`);
    console.log(`  ${p.vendedor} · ${p.id}`);
    for (const f of p.faltas) console.log(`    ✗ ${f}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
