/**
 * Tira da fila de moderação os anúncios importados INCOMPLETOS (item 5).
 *
 * Contexto: o parser antigo descartava categoria e dados de frete, então uma
 * importação de 363 linhas encheu a fila com anúncios que não passam na peneira
 * — não dá para aprovar nem publicar. Se a equipe abrir a fila assim, encontra
 * centenas de itens intratáveis e os envios de verdade ficam escondidos.
 *
 * Move para `draft` (nada é apagado). O vendedor reimporta com o modelo novo,
 * que agora preserva categoria, peso e dimensões.
 *
 * Escopo estreito de propósito: SÓ `pending_review` sem categoria OU sem peso.
 * Importado que estiver completo continua na fila para a equipe avaliar.
 *
 * Dry-run por padrão:
 *   npx ts-node --transpile-only scripts/limpar-fila-importacao.ts
 *   npx ts-node --transpile-only scripts/limpar-fila-importacao.ts --apply
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const APPLY = process.argv.includes('--apply');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const INCOMPLETOS = `
  status = 'pending_review'
  AND (category_id IS NULL OR weight_grams IS NULL OR weight_grams <= 0)`;

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}\n`);

  const porVendedor = await client.execute(`
    SELECT COALESCE(u.name, '?') AS nome, u.email, COUNT(*) AS qtd
      FROM listings l LEFT JOIN users u ON u.id = l.seller_id
     WHERE ${INCOMPLETOS}
     GROUP BY l.seller_id ORDER BY qtd DESC`);

  const total = porVendedor.rows.reduce(
    (acc, r: any) => acc + Number(r.qtd),
    0,
  );
  console.log(`Importados incompletos na fila: ${total}`);
  for (const r of porVendedor.rows as any[]) {
    console.log(`  ${String(r.qtd).padStart(4)}  ${r.nome} <${r.email ?? '?'}>`);
  }

  const restante = await client.execute(
    `SELECT COUNT(*) AS n FROM listings WHERE status='pending_review' AND NOT (${INCOMPLETOS.replace('status = \'pending_review\'\n  AND ', '')})`,
  );
  console.log(
    `\nFicam na fila (completos): ${(restante.rows[0] as any).n}`,
  );

  if (total === 0) return console.log('\nNada a mover.');
  if (!APPLY) {
    return console.log(
      `\n[dry-run] Nada alterado. Rode com --apply para mover estes ${total} para 'draft'.\n`,
    );
  }

  const r = await client.execute({
    sql: `UPDATE listings SET status='draft', updated_at=? WHERE ${INCOMPLETOS}`,
    // `mode: 'timestamp'` no schema = Unix em SEGUNDOS (não ms).
    args: [Math.floor(Date.now() / 1000)],
  });

  const conferencia = await client.execute(
    `SELECT status, COUNT(*) AS n FROM listings GROUP BY status ORDER BY n DESC`,
  );
  console.log(`\n✅ ${r.rowsAffected} anúncio(s) movido(s) para 'draft'.\n`);
  for (const c of conferencia.rows as any[]) {
    console.log(`  ${String(c.status).padEnd(16)} ${c.n}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
