/**
 * Cria `recipient_status_history`: registro append-only do que a Pagar.me
 * respondeu sobre cada recebedor, e quando.
 *
 * Por que existe: hoje `seller_profiles.pagarme_recipient_status` é
 * SOBRESCRITO a cada webhook, e `webhook_events` guarda só id e tipo do evento
 * — sem payload. Ou seja, não sobra prova de que a Pagar.me devolveu `active`.
 *
 * Isso passou a importar em 01/08: na conta nova os recebedores voltam `active`
 * na hora, **sem que o link de KYC seja emitido** (o endpoint responde 401 — ver
 * docs/PLAN-pagarme-conta-nova.md). Se mais tarde esses cadastros forem
 * reavaliados e a prova de vida cobrada retroativamente, a única evidência de
 * que eles próprios aprovaram são os logs da Render, que expiram. Com a feira
 * de 02/08 criando dezenas de recebedores num dia, isso vira caro rápido.
 *
 * `user_id` NÃO tem foreign key de propósito: trilha de auditoria não pode ser
 * apagada em cascata junto com o usuário — é justamente quando alguém some que
 * o registro importa.
 *
 * Idempotente: só cria se ainda não existir.
 *   npx ts-node --transpile-only scripts/add-recipient-status-history.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const DDL = `
CREATE TABLE recipient_status_history (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  recipient_id text NOT NULL,
  status text NOT NULL,
  source text NOT NULL,
  provider_event_id text,
  kyc_link_issued integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
)`;

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);

  const tabelas = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='recipient_status_history'",
  );

  if (tabelas.rows.length > 0) {
    console.log('recipient_status_history já existe — nada a fazer.');
  } else {
    await client.execute(DDL);
    await client.execute(
      'CREATE INDEX recipient_status_history_recipient_idx ON recipient_status_history (recipient_id, created_at)',
    );
    console.log('recipient_status_history criada (+ índice por recebedor).');
  }

  const info = await client.execute("PRAGMA table_info('recipient_status_history')");
  console.log('\nColunas:');
  info.rows.forEach((r: any) => console.log(`  ${r.name} ${r.type}`));

  const n = await client.execute(
    'SELECT COUNT(*) AS n FROM recipient_status_history',
  );
  console.log(`\nLinhas: ${n.rows[0].n}`);
})();
