/**
 * Adiciona `seller_profiles.avatar_url`: foto da loja. Aditivo e nullable —
 * null = o front cai na foto do perfil (Clerk) ou nas iniciais.
 *
 * Obrigatório ANTES de subir o backend: `ensureProfile` faz `select()` da
 * tabela inteira, então a coluna no schema.ts sem a coluna no banco derruba
 * GET /api/seller/profile com 500 (mesmo incidente de /api/listings).
 *
 * Idempotente: só cria se ainda não existir.
 *   npx ts-node --transpile-only scripts/add-seller-avatar-url.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);
  const info = await client.execute("PRAGMA table_info('seller_profiles')");
  const existe = info.rows.some((r: any) => r.name === 'avatar_url');

  if (existe) {
    console.log('ℹ️  seller_profiles.avatar_url já existe — nada a fazer.');
  } else {
    await client.execute('ALTER TABLE seller_profiles ADD COLUMN avatar_url text');
    console.log('✅ Coluna seller_profiles.avatar_url criada.');
  }

  const depois = await client.execute("PRAGMA table_info('seller_profiles')");
  console.log(
    'verificação:',
    depois.rows.some((r: any) => r.name === 'avatar_url') ? 'OK' : 'FALTA',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
