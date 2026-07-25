/**
 * Grava o telefone de um usuário em `users.phone` (só dígitos).
 *
 * Usado para destravar quem já tinha cartão salvo antes de o formulário passar
 * a pedir telefone: com o número no banco, o `getCardRef` completa o customer
 * na Pagar.me no próximo lance (PUT) e a pré-autorização passa a autorizar.
 *
 *   npx ts-node --transpile-only scripts/set-user-phone.ts <userId> <telefone>
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const [userId, telefoneBruto] = process.argv.slice(2);
  if (!userId || !telefoneBruto) {
    console.error('Uso: set-user-phone.ts <userId> <telefone>');
    process.exit(1);
  }

  const phone = telefoneBruto.replace(/\D/g, '');
  if (phone.length < 10 || phone.length > 11) {
    console.error(`Telefone inválido (${phone.length} dígitos): use DDD + número.`);
    process.exit(1);
  }

  const antes = await client.execute({
    sql: 'SELECT id, name, email, phone FROM users WHERE id = ?',
    args: [userId],
  });
  if (antes.rows.length === 0) {
    console.error(`Usuário ${userId} não encontrado.`);
    process.exit(1);
  }
  console.log('Antes:', JSON.stringify(antes.rows[0]));

  await client.execute({
    sql: 'UPDATE users SET phone = ?, updated_at = ? WHERE id = ?',
    args: [phone, Math.floor(Date.now() / 1000), userId],
  });

  const depois = await client.execute({
    sql: 'SELECT id, name, phone FROM users WHERE id = ?',
    args: [userId],
  });
  console.log('Depois:', JSON.stringify(depois.rows[0]));
})();
