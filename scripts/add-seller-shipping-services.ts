/**
 * Adiciona `seller_profiles.shipping_services`: com quais transportadoras o
 * vendedor topa trabalhar. CSV de ids do Melhor Envio ('1,2,17'), no mesmo
 * formato do MELHOR_ENVIO_SERVICOS.
 *
 * Aditivo e nullable. null = usa o conjunto da plataforma, que é o
 * comportamento de hoje e o estado de todo mundo. Não precisa de backfill.
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
 *   npx ts-node --transpile-only scripts/add-seller-shipping-services.ts
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
  const existe = info.rows.some((r: any) => r.name === 'shipping_services');

  if (existe) {
    console.log('ℹ️  seller_profiles.shipping_services já existe, nada a fazer.');
  } else {
    await client.execute(
      'ALTER TABLE seller_profiles ADD COLUMN shipping_services text',
    );
    console.log('✅ Coluna seller_profiles.shipping_services criada.');
  }

  const depois = await client.execute("PRAGMA table_info('seller_profiles')");
  console.log(
    'verificação:',
    depois.rows.some((r: any) => r.name === 'shipping_services') ? 'OK' : 'FALTA',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
