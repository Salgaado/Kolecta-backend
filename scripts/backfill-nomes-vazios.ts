/**
 * Preenche `users.name` de quem ficou com string VAZIA.
 *
 * Quem se cadastra só com e-mail e senha chega sem first_name/last_name no
 * Clerk, e o webhook antigo gravava ''. Isso é pior que nulo: passa batido por
 * todo `?? 'Vendedor Kolecta'` (que só pega null/undefined) e o anúncio aparece
 * na vitrine sem vendedor nenhum.
 *
 * Usa a parte local do e-mail — o mesmo fallback que o webhook passou a aplicar.
 * Não inventa nome de pessoa: `culturetcg.br@gmail.com` vira `culturetcg.br`,
 * que é reconhecível para o próprio vendedor e ele pode trocar depois pelo nome
 * da loja (seller_profiles.store_name).
 *
 * Dry-run por padrão:
 *   npx ts-node --transpile-only scripts/backfill-nomes-vazios.ts --apply
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const APPLY = process.argv.includes('--apply');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const alvos = (
    await client.execute(`
      SELECT id, email, name FROM users
       WHERE (name IS NULL OR trim(name) = '') AND email IS NOT NULL
       ORDER BY created_at DESC`)
  ).rows as any[];

  console.log(`Usuários sem nome: ${alvos.length}\n`);
  for (const u of alvos) {
    const sugerido = String(u.email).split('@')[0].trim();
    console.log(`  ${String(u.email).padEnd(34)} → "${sugerido}"`);
  }

  if (alvos.length === 0) return;
  if (!APPLY) {
    return console.log(
      `\n[dry-run] Nada alterado. Rode com --apply para preencher estes ${alvos.length}.\n`,
    );
  }

  let n = 0;
  for (const u of alvos) {
    const nome = String(u.email).split('@')[0].trim();
    if (!nome) continue;
    await client.execute({
      sql: 'UPDATE users SET name = ?, updated_at = ? WHERE id = ?',
      // `mode: 'timestamp'` no schema = Unix em SEGUNDOS (não ms).
      args: [nome, Math.floor(Date.now() / 1000), u.id],
    });
    n++;
  }

  const resto = await client.execute(
    "SELECT COUNT(*) AS n FROM users WHERE name IS NULL OR trim(name) = ''",
  );
  console.log(
    `\n✅ ${n} nome(s) preenchido(s). Ainda sem nome: ${(resto.rows[0] as any).n}\n`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
