/**
 * Adiciona `seller_profiles.accepts_pickup`: o vendedor entrega em mãos?
 *
 * A opção "Retirada pessoal" aparecia no checkout de TODO vendedor, inclusive o
 * de outro estado, que depois tinha de explicar ao comprador que não dava.
 *
 * Aditivo e nullable. null = aceita, que é o comportamento de hoje e o estado
 * de todo mundo. Não precisa de backfill.
 *
 * Obrigatório ANTES de subir o backend: `ensureProfile` faz `select()` da
 * tabela inteira, então a coluna no schema.ts sem a coluna no banco derruba
 * GET /api/seller/profile com 500 (mesmo incidente de /api/listings).
 *
 * A COTAÇÃO não depende disto: ela lê a coluna dentro de um try/catch e cai no
 * conjunto da plataforma se ela não existir. Ou seja, na pior das hipóteses o
 * checkout continua funcionando e só o painel do vendedor quebra.
 *
 * Idempotente: só cria se ainda não existir.
 *   npx ts-node --transpile-only scripts/add-seller-accepts-pickup.ts
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
  const existe = info.rows.some((r: any) => r.name === 'accepts_pickup');

  if (existe) {
    console.log('ℹ️  seller_profiles.accepts_pickup já existe, nada a fazer.');
  } else {
    await client.execute(
      'ALTER TABLE seller_profiles ADD COLUMN accepts_pickup integer',
    );
    console.log('✅ Coluna seller_profiles.accepts_pickup criada.');
  }

  const depois = await client.execute("PRAGMA table_info('seller_profiles')");
  console.log(
    'verificação:',
    depois.rows.some((r: any) => r.name === 'accepts_pickup') ? 'OK' : 'FALTA',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
