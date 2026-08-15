/**
 * Adiciona `withdrawal_requests.fee_in_cents`: a taxa de saque da Pagar.me
 * (R$ 3,67 fixos) cobrada em cada transferência.
 *
 * Por que existe: até 13/08/2026 a carteira debitava só o principal, enquanto a
 * Pagar.me debitava principal + taxa do saldo do recebedor. A carteira ficava
 * R$ 3,67 mais rica que a realidade a cada saque, o erro acumulava, e "sacar
 * tudo" nunca funcionava — o último saque sempre pedia mais do que existia.
 * Ver `docs/PLAN-taxa-de-saque.md`.
 *
 * As linhas antigas ficam com 0: naquela época a taxa de fato não passava pela
 * carteira. O desvio histórico que elas deixaram é corrigido à parte, por
 * lançamento no ledger — não mexendo nestas linhas.
 *
 * ⚠️ `drizzle-kit push` está quebrado neste repo (propõe DROP de
 * `analytics_events`). Migração de coluna é por ALTER TABLE, como este script.
 *
 * Idempotente: só cria se ainda não existir.
 *   npx ts-node --transpile-only scripts/add-withdrawal-fee.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);

  const info = await client.execute("PRAGMA table_info('withdrawal_requests')");
  const existe = info.rows.some((r: any) => r.name === 'fee_in_cents');

  if (existe) {
    console.log('withdrawal_requests.fee_in_cents já existe — nada a fazer.');
  } else {
    await client.execute(
      'ALTER TABLE withdrawal_requests ADD COLUMN fee_in_cents integer NOT NULL DEFAULT 0',
    );
    console.log('withdrawal_requests.fee_in_cents criada (default 0).');
  }

  const r = await client.execute(
    `SELECT status, COUNT(*) AS n, SUM(amount_in_cents) AS valor, SUM(fee_in_cents) AS taxa
     FROM withdrawal_requests GROUP BY status`,
  );
  console.log('\nSaques por status:');
  for (const linha of r.rows as any[]) {
    const brl = (c: any) => `R$ ${(Number(c || 0) / 100).toFixed(2)}`;
    console.log(
      `  ${String(linha.status).padEnd(12)} ${String(linha.n).padStart(3)}x  valor ${brl(linha.valor).padStart(12)}  taxa ${brl(linha.taxa)}`,
    );
  }
})();
