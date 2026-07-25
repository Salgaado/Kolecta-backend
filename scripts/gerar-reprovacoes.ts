/**
 * Gera o comando de reprovação dos ativos incompletos, para colar no console do
 * navegador logado como admin.
 *
 * Por que não reprovar direto daqui: o e-mail só sai com a config do Render
 * (MAIL_ENABLED + RESEND_API_KEY), e subir o Nest local contra o banco de
 * PRODUÇÃO ligaria os crons (fechamento de leilão, release de saldo) — risco
 * grande para uma tarefa de 13 linhas. Passando pelo endpoint de admin, a ação
 * roda no caminho real: grava moderated_by/moderated_at e dispara o e-mail.
 *
 *   npx ts-node --transpile-only scripts/gerar-reprovacoes.ts
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
    await client.execute(
      `SELECT l.*, COALESCE(u.name,'?') AS seller_name
         FROM listings l LEFT JOIN users u ON u.id = l.seller_id
        WHERE l.status = 'active' ORDER BY u.name, l.title`,
    )
  ).rows as any[];

  const auctions = (
    await client.execute(
      'SELECT listing_id, starting_bid_in_cents, reserve_price_in_cents FROM auctions',
    )
  ).rows as any[];
  const auctionByListing = new Map(auctions.map((a) => [a.listing_id, a]));

  const alvos: Array<{ id: string; titulo: string; motivo: string }> = [];

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

    if (faltas.length === 0) continue;

    // O motivo vai inteiro para o e-mail e para a tela do vendedor: precisa
    // dizer o que fazer, não só que está errado.
    alvos.push({
      id: r.id,
      titulo: r.title,
      motivo: `Para voltar ao ar, complete: ${faltas.join('; ')}.`,
    });
  }

  console.log(`\n${alvos.length} anúncio(s) ativo(s) com pendência.\n`);
  console.log(
    '── Cole no console do navegador, logado como admin em kolecta.com.br ──\n',
  );
  console.log(`const alvos = ${JSON.stringify(alvos, null, 2)};

const token = await window.Clerk.session.getToken();
for (const a of alvos) {
  const r = await fetch(
    \`https://kolecta-backend.onrender.com/api/admin/listings/\${a.id}/status\`,
    {
      method: 'PATCH',
      headers: {
        Authorization: \`Bearer \${token}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'rejected', reason: a.motivo }),
    },
  );
  console.log(r.ok ? '✅' : '❌', r.status, a.titulo);
}
console.log('fim');`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
