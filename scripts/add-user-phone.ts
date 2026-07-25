/**
 * Adiciona `users.phone`: telefone com DDD (só dígitos).
 *
 * Por que existe: a Pagar.me EXIGE ao menos um telefone no `customer` para
 * autorizar cartão ("At least one customer phone is required"). O checkout já
 * pedia o número, mas mandava inline e descartava. O lance cobra pelo
 * `customer_id`, então sem o telefone GRAVADO a pré-autorização é recusada —
 * foi exatamente o que travou o lance da Artminis.
 *
 * Idempotente: só cria se ainda não existir.
 *   npx ts-node --transpile-only scripts/add-user-phone.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);
  const info = await client.execute("PRAGMA table_info('users')");
  const existe = info.rows.some((r: any) => r.name === 'phone');

  if (existe) {
    console.log('users.phone já existe — nada a fazer.');
  } else {
    await client.execute('ALTER TABLE users ADD COLUMN phone text');
    console.log('users.phone criada.');
  }

  const comTelefone = await client.execute(
    "SELECT COUNT(*) AS n FROM users WHERE phone IS NOT NULL AND phone != ''",
  );
  const total = await client.execute('SELECT COUNT(*) AS n FROM users');
  console.log(
    `Usuários com telefone: ${comTelefone.rows[0].n} de ${total.rows[0].n}`,
  );
})();
