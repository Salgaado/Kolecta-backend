/**
 * Adiciona `community_comments.listing_id`: o anúncio mencionado no comentário.
 *
 * Dá ao vendedor um motivo legítimo de participar da comunidade (mostrar a peça
 * dele) sem mandar ninguém para fora. É o par da regra que bloqueia link
 * externo em comentário: tira o caminho de fora e abre o de dentro.
 *
 * Aditivo e nullable. null = comentário sem menção, que é o caso dos 9 que
 * existem hoje. Não precisa de backfill.
 *
 * Obrigatório ANTES de subir o backend: a fila de moderação e a listagem de
 * comentários passam a selecionar a coluna.
 *
 * Idempotente.
 *   npx ts-node --transpile-only scripts/add-comment-listing-id.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);
  const info = await client.execute("PRAGMA table_info('community_comments')");
  if (info.rows.some((r: any) => r.name === 'listing_id')) {
    console.log('ℹ️  community_comments.listing_id já existe, nada a fazer.');
  } else {
    // Sem REFERENCES no ALTER: o SQLite não permite adicionar coluna com chave
    // estrangeira a uma tabela existente. A integridade fica na aplicação, que
    // valida o anúncio antes de gravar.
    await client.execute(
      'ALTER TABLE community_comments ADD COLUMN listing_id text',
    );
    console.log('✅ Coluna community_comments.listing_id criada.');
  }
  const depois = await client.execute("PRAGMA table_info('community_comments')");
  console.log(
    'verificação:',
    depois.rows.some((r: any) => r.name === 'listing_id') ? 'OK' : 'FALTA',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
