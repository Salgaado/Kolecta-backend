/**
 * Preenche `orders.address_id` nos pedidos de leilão que nasceram sem endereço.
 *
 * O leilão não tem checkout — o lance é só o valor da peça —, então o pedido
 * era criado sem endereço e a etiqueta do Melhor Envio nem chegava a ser
 * pedida. O código já grava o endereço padrão do vencedor; este script cobre
 * os pedidos criados antes disso.
 *
 * Usa o endereço padrão do comprador (ou o primeiro, se não houver padrão).
 * Só toca em pedidos de leilão sem endereço e com entrega por transportadora.
 *
 *   npx ts-node --transpile-only scripts/backfill-address-leilao.ts          # simula
 *   npx ts-node --transpile-only scripts/backfill-address-leilao.ts --aplicar
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const aplicar = process.argv.includes('--aplicar');
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);
  console.log(aplicar ? 'MODO: aplicando\n' : 'MODO: simulação (use --aplicar)\n');

  // Pedido de leilão = anúncio do tipo 'auction'. Só os sem endereço e que
  // vão por transportadora (retirada não gera etiqueta).
  const pedidos = await client.execute(`
    SELECT o.id, o.buyer_id, o.status, o.delivery_method, u.name AS comprador,
           l.title
    FROM orders o
    JOIN listings l ON l.id = o.listing_id
    LEFT JOIN users u ON u.id = o.buyer_id
    WHERE l.type = 'auction'
      AND (o.address_id IS NULL OR o.address_id = '')
      AND COALESCE(o.delivery_method, 'shipping') = 'shipping'
    ORDER BY o.created_at DESC`);

  if (pedidos.rows.length === 0) {
    console.log('Nenhum pedido de leilão sem endereço.');
    return;
  }

  let corrigidos = 0;
  let semEndereco = 0;

  for (const p of pedidos.rows as any[]) {
    const ends = await client.execute({
      sql: 'SELECT id, is_default, street, number, city, state FROM addresses WHERE user_id = ?',
      args: [p.buyer_id],
    });
    const rows = ends.rows as any[];
    const end = rows.find((e) => e.is_default) ?? rows[0];

    if (!end) {
      console.log(`  ✗ ${p.id} — ${p.comprador ?? p.buyer_id} NÃO tem endereço cadastrado`);
      semEndereco++;
      continue;
    }

    console.log(
      `  ✓ ${p.id} [${p.status}] "${p.title}" → ${end.street}, ${end.number} - ${end.city}/${end.state}`,
    );
    if (aplicar) {
      await client.execute({
        sql: 'UPDATE orders SET address_id = ?, updated_at = ? WHERE id = ?',
        args: [end.id, Math.floor(Date.now() / 1000), p.id],
      });
    }
    corrigidos++;
  }

  console.log(
    `\n${corrigidos} pedido(s) ${aplicar ? 'corrigidos' : 'a corrigir'}` +
      (semEndereco ? ` | ${semEndereco} sem endereço cadastrado` : ''),
  );
})();
