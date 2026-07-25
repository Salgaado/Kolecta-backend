/**
 * Busca um pedido na Pagar.me e mostra POR QUE ele foi recusado.
 *
 * Existe porque o painel esconde o campo que importa: quando o adquirente
 * aprova (`acquirer_return_code: 0000`) e a cobrança fica `not_authorized`,
 * quem reprovou foi a Pagar.me — e isso só aparece em `antifraud_response`.
 *
 * A chave NÃO vai por argumento (ficaria no histórico do shell). Use uma env:
 *   PAGARME_SECRET_KEY_LIVE=sk_live_... (ou PAGARME_SECRET_KEY no .env)
 *
 *   npx ts-node --transpile-only scripts/inspecionar-order-pagarme.ts or_XXXX
 */
import 'dotenv/config';

const chave =
  process.env.PAGARME_SECRET_KEY_LIVE || process.env.PAGARME_SECRET_KEY;

(async () => {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error('Uso: inspecionar-order-pagarme.ts <or_...>');
    process.exit(1);
  }
  if (!chave) {
    console.error(
      'Defina PAGARME_SECRET_KEY_LIVE (ou PAGARME_SECRET_KEY) no .env.',
    );
    process.exit(1);
  }
  console.log(`Chave: ${chave.slice(0, 8)}… (${chave.startsWith('sk_live') ? 'PRODUÇÃO' : 'teste'})`);

  const res = await fetch(`https://api.pagar.me/core/v5/orders/${orderId}`, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${chave}:`).toString('base64'),
      'User-Agent': 'Kolecta App (contato@kolecta.com)',
    },
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}:`, (await res.text()).slice(0, 500));
    process.exit(1);
  }

  const o: any = await res.json();
  const brl = (v: any) => 'R$ ' + (Number(v ?? 0) / 100).toFixed(2);

  console.log(`\n=== ${o.id} ===`);
  console.log('status  :', o.status);
  console.log('valor   :', brl(o.amount));

  for (const ch of o.charges ?? []) {
    const tx = ch.last_transaction ?? {};
    console.log(`\n--- cobrança ${ch.id} [${ch.status}] ---`);
    console.log('transação status    :', tx.status);
    console.log('acquirer_return_code:', tx.acquirer_return_code);
    console.log('acquirer_message    :', tx.acquirer_message);
    console.log('gateway_response    :', JSON.stringify(tx.gateway_response));
    // O campo que o painel não mostra de forma óbvia.
    console.log('ANTIFRAUDE          :', JSON.stringify(tx.antifraud_response ?? null));

    if (Array.isArray(ch.splits) && ch.splits.length) {
      console.log('split:');
      for (const s of ch.splits) {
        console.log(`   ${s.recipient_id ?? s.recipient?.id} → ${brl(s.amount)} (${s.type})`);
      }
    }
  }
})();
