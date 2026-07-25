/**
 * Troca o papel de um usuário (user ⇄ admin).
 *
 * O papel vem do NOSSO banco (`users.role`) — o front lê pelo perfil do
 * backend, não pelo Clerk —, então alterar a linha basta.
 *
 * ⚠️ `admin` não é só um selo: abre moderação, lista de usuários, relatórios
 * financeiros e disputas, e é o ÚNICO jeito de furar o gate de pré-lançamento.
 * Use temporariamente e reverta.
 *
 *   npx ts-node --transpile-only scripts/definir-role.ts <email> <user|admin>
 *   npx ts-node --transpile-only scripts/definir-role.ts <email> <user|admin> --aplicar
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const [email, papel] = process.argv.slice(2);
  const aplicar = process.argv.includes('--aplicar');

  if (!email || !['user', 'admin'].includes(papel)) {
    console.error('Uso: definir-role.ts <email> <user|admin> [--aplicar]');
    process.exit(1);
  }

  const r = await client.execute({
    sql: 'SELECT id, name, email, role FROM users WHERE lower(email) = ?',
    args: [email.toLowerCase()],
  });
  if (!r.rows.length) {
    console.error(`Nenhum usuário com o e-mail ${email}.`);
    process.exit(1);
  }
  const u: any = r.rows[0];
  console.log(`${u.name} <${u.email}>`);
  console.log(`  papel atual : ${u.role}`);
  console.log(`  papel novo  : ${papel}`);

  if (u.role === papel) {
    console.log('\nJá está nesse papel — nada a fazer.');
    return;
  }
  if (!aplicar) {
    console.log('\nSimulação. Rode com --aplicar.');
    return;
  }

  await client.execute({
    sql: 'UPDATE users SET role = ?, updated_at = ? WHERE id = ?',
    args: [papel, Math.floor(Date.now() / 1000), u.id],
  });
  console.log(`\n✓ ${u.email} agora é "${papel}".`);
  if (papel === 'admin') {
    console.log('  Lembre de reverter depois do teste:');
    console.log(`  npx ts-node --transpile-only scripts/definir-role.ts ${u.email} user --aplicar`);
  }
})();
