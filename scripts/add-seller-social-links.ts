/**
 * Colunas das redes sociais da loja.
 *
 *   seller_profiles.social_tiktok    — handle do TikTok, sem @. null = não informado.
 *   seller_profiles.social_instagram — handle do Instagram, sem @. null = não informado.
 *   seller_profiles.social_youtube   — caminho do canal ('@nome', 'c/nome',
 *                                      'channel/UC…'). null = não informado.
 *
 * Guardamos o IDENTIFICADOR, não a URL: a URL é montada na saída por
 * `montarRedes()`. Assim um link podre gravado antes desta regra existir não
 * vira `href` na loja pública, e trocar o domínio de uma rede é mexer em um
 * lugar só.
 *
 * O `website` já existe desde antes e não ganha coluna nova — ele só passa a
 * ser exibido, com o mesmo saneamento na saída.
 *
 * Todas aditivas e nullable, sem backfill: null é o estado de todo mundo hoje e
 * significa "sem ícone na loja".
 *
 * ── Por que um script e não `drizzle-kit push` ──────────────────────────────
 *
 * O push está QUEBRADO neste banco, e não por causa desta mudança. O índice
 * único do slug foi criado como `uq_seller_slug`, enquanto o `.unique()` do
 * schema.ts faz o drizzle esperar `seller_profiles_slug_unique`. Ele tenta
 * derrubar um índice que não existe e o batch inteiro morre:
 *
 *     LibsqlBatchError: no such index: seller_profiles_slug_unique
 *
 * Pior: para reconciliar o resto do schema, o push também gera DROP/recreate de
 * tabelas que nada têm a ver com redes sociais (analytics_events, 15.900
 * linhas). Um ALTER TABLE ADD COLUMN não toca em nada além do que precisa.
 *
 * ── Obrigatório ANTES de subir o backend ────────────────────────────────────
 *
 * `ensureProfile` faz `select()` da tabela inteira em `seller_profiles`, então
 * coluna no schema.ts sem coluna no banco derruba `/api/seller` com 500 para
 * TODOS os vendedores (é o incidente de 24/07 em `/api/listings`).
 *
 * Idempotente: só cria o que ainda não existe.
 *   npx ts-node --transpile-only scripts/add-seller-social-links.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const COLUNAS: { tabela: string; coluna: string; tipo: string }[] = [
  { tabela: 'seller_profiles', coluna: 'social_tiktok', tipo: 'text' },
  { tabela: 'seller_profiles', coluna: 'social_instagram', tipo: 'text' },
  { tabela: 'seller_profiles', coluna: 'social_youtube', tipo: 'text' },
];

async function colunasDe(tabela: string): Promise<string[]> {
  const info = await client.execute(`PRAGMA table_info('${tabela}')`);
  return info.rows.map((r: any) => r.name as string);
}

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}\n`);

  for (const { tabela, coluna, tipo } of COLUNAS) {
    const existentes = await colunasDe(tabela);
    if (existentes.includes(coluna)) {
      console.log(`ℹ️  ${tabela}.${coluna} já existe, nada a fazer.`);
      continue;
    }
    await client.execute(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
    console.log(`✅ ${tabela}.${coluna} criada (${tipo}).`);
  }

  console.log('\nverificação:');
  let faltando = 0;
  for (const { tabela, coluna } of COLUNAS) {
    const ok = (await colunasDe(tabela)).includes(coluna);
    if (!ok) faltando++;
    console.log(`  ${ok ? 'OK  ' : 'FALTA'} ${tabela}.${coluna}`);
  }
  process.exit(faltando ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
