/**
 * Adiciona `orders.shipping_cost_in_cents` e `orders.shipping_subsidy_in_cents`.
 *
 * São as colunas do frete compartilhado (`docs/PLAN-frete-compartilhado.md`):
 * com a Kolecta bancando parte do frete, o comprador paga `F − S` e o custo
 * real da etiqueta some do banco se ninguém o guardar. `platform_fee` passaria
 * a valer comissão + frete-já-descontado, e a receita ficaria superestimada em
 * exatamente o subsídio — o mesmo bug que inflou o painel financeiro em ~4× em
 * 31/07, de roupa nova.
 *
 * Invariante depois desta migração, para todo pedido NOVO:
 *
 *     shipping_cost_in_cents = shipping_in_cents + shipping_subsidy_in_cents
 *
 * Aditivo e nullable. Pedido antigo fica com as duas nulas, e é a resposta
 * certa: `subsidy = null` ≡ 0 (ninguém subsidiou nada antes de hoje) e
 * `cost = null` cai no `|| shippingInCents` de quem lê. **Não precisa de
 * backfill.**
 *
 * OBRIGATÓRIO ANTES DE SUBIR O BACKEND. `orders` é lido com `select()` da
 * tabela inteira em vários lugares: coluna no `schema.ts` sem coluna no banco
 * derruba o endpoint com 500 — é o incidente de `/api/listings` (24/07), e
 * repeti-lo em `orders` significa checkout fora do ar.
 *
 * `drizzle-kit push` NÃO serve aqui: o índice de slug do vendedor diverge entre
 * schema e banco e o push ainda propõe DROP de `analytics_events` (15.900
 * linhas). Por isso ALTER TABLE na mão.
 *
 * Idempotente: só cria o que ainda não existe.
 *   npx ts-node --transpile-only scripts/add-order-shipping-subsidy.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const COLUNAS = [
  'shipping_cost_in_cents',
  'shipping_subsidy_in_cents',
] as const;

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);

  const info = await client.execute("PRAGMA table_info('orders')");
  const existentes = new Set(info.rows.map((r: any) => r.name));

  for (const coluna of COLUNAS) {
    if (existentes.has(coluna)) {
      console.log(`ℹ️  orders.${coluna} já existe, nada a fazer.`);
      continue;
    }
    await client.execute(`ALTER TABLE orders ADD COLUMN ${coluna} integer`);
    console.log(`✅ Coluna orders.${coluna} criada.`);
  }

  const depois = await client.execute("PRAGMA table_info('orders')");
  const agora = new Set(depois.rows.map((r: any) => r.name));
  for (const coluna of COLUNAS) {
    console.log(`verificação ${coluna}:`, agora.has(coluna) ? 'OK' : 'FALTA');
  }

  // Nenhum pedido deveria ter subsídio antes da política ligar. Se algum tiver,
  // é sinal de que o backend subiu antes desta migração e gravou torto.
  const comSubsidio = await client.execute(
    'SELECT COUNT(*) AS n FROM orders WHERE shipping_subsidy_in_cents > 0',
  );
  console.log(
    `pedidos com subsídio gravado: ${(comSubsidio.rows[0] as any).n}`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
