/**
 * Cancela um pedido que ficou `pending` e devolve o anúncio para `active`.
 *
 * Espelha o que `OrdersService.cancelPendingOrder` faz: só age se o pedido
 * ainda estiver `pending` (guarda de concorrência — se o pagamento entrar no
 * meio, não cancela) e libera o anúncio que estava travado em
 * `pending_payment`.
 *
 *   npx ts-node --transpile-only scripts/cancelar-pedido-pendente.ts <orderId>
 *   npx ts-node --transpile-only scripts/cancelar-pedido-pendente.ts <orderId> --aplicar
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const orderId = process.argv[2];
  const aplicar = process.argv.includes('--aplicar');
  if (!orderId) {
    console.error('Uso: cancelar-pedido-pendente.ts <orderId> [--aplicar]');
    process.exit(1);
  }

  const r = await client.execute({
    sql: `SELECT o.id, o.status, o.listing_id, o.total_in_cents,
                 o.pagarme_order_id, l.title, l.status AS listing_status
          FROM orders o LEFT JOIN listings l ON l.id = o.listing_id
          WHERE o.id = ?`,
    args: [orderId],
  });
  if (!r.rows.length) {
    console.error(`Pedido ${orderId} não encontrado.`);
    process.exit(1);
  }
  const o: any = r.rows[0];
  console.log(`Pedido  : ${o.id} [${o.status}] R$ ${(Number(o.total_in_cents) / 100).toFixed(2)}`);
  console.log(`Anúncio : ${o.title} [${o.listing_status}]`);
  console.log(`Pagar.me: ${o.pagarme_order_id ?? '— (nenhuma cobrança criada)'}`);

  if (o.status !== 'pending') {
    console.log(`\nNada a fazer: só cancelo pedido 'pending' (este está '${o.status}').`);
    return;
  }
  // Cobrança criada exigiria estorno/reconciliação na Pagar.me — fora do escopo
  // deste script, que é só para pedido que nunca chegou ao gateway.
  if (o.pagarme_order_id) {
    console.log('\nEste pedido TEM cobrança na Pagar.me — cancele pelo fluxo do app.');
    return;
  }

  if (!aplicar) {
    console.log('\nSimulação. Rode com --aplicar para cancelar.');
    return;
  }

  const agora = Math.floor(Date.now() / 1000);
  const upd = await client.execute({
    sql: `UPDATE orders SET status='cancelled', updated_at=? WHERE id=? AND status='pending'`,
    args: [agora, orderId],
  });
  if (upd.rowsAffected === 0) {
    console.log('\nO pedido saiu de "pending" no meio do caminho — nada alterado.');
    return;
  }
  await client.execute({
    sql: `UPDATE listings SET status='active', updated_at=? WHERE id=?`,
    args: [agora, o.listing_id],
  });
  console.log('\n✓ Pedido cancelado e anúncio liberado (active).');
})();
