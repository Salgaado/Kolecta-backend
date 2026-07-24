/**
 * Backfill de peso/dimensões (pendências 1.3) — preenche os anúncios JÁ ATIVOS
 * que foram publicados antes da peneira existir e ficaram sem dados de frete.
 * Sem eles a cotação sai errada e o vendedor perde dinheiro na etiqueta.
 *
 * Valores = os mesmos defaults que o ShippingService já aplica em memória
 * (`shipping.service.ts`, pacote "colecionável"), então o frete cobrado NÃO muda:
 * só deixa de ser implícito e passa a valer para a etiqueta.
 *
 * Escopo proposital: só `status = 'active'`. Rascunho e em análise ficam de fora
 * de propósito — para esses a peneira agora EXIGE que o vendedor informe as
 * medidas reais na publicação, e preencher aqui mataria essa exigência.
 *
 * Dry-run por padrão. Para aplicar:
 *   npx ts-node --transpile-only scripts/backfill-shipping-dimensions.ts --apply
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const APPLY = process.argv.includes('--apply');

// Espelha os defaults de `shipping.service.ts` (weight 0.3kg / 16 x 6 x 12 cm).
const DEFAULT_WEIGHT_GRAMS = Number(
  process.env.SHIPPING_DEFAULT_WEIGHT_KG
    ? Number(process.env.SHIPPING_DEFAULT_WEIGHT_KG) * 1000
    : 300,
);
const DEFAULT_WIDTH_CM = Number(process.env.SHIPPING_DEFAULT_WIDTH_CM ?? 16);
const DEFAULT_HEIGHT_CM = Number(process.env.SHIPPING_DEFAULT_HEIGHT_CM ?? 6);
const DEFAULT_LENGTH_CM = Number(process.env.SHIPPING_DEFAULT_LENGTH_CM ?? 12);

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const FALTANDO = `
  status = 'active' AND (
    weight_grams IS NULL OR weight_grams <= 0 OR
    width_cm  IS NULL OR width_cm  <= 0 OR
    height_cm IS NULL OR height_cm <= 0 OR
    length_cm IS NULL OR length_cm <= 0
  )`;

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);
  console.log(
    `Default: ${DEFAULT_WEIGHT_GRAMS}g, ${DEFAULT_WIDTH_CM}x${DEFAULT_HEIGHT_CM}x${DEFAULT_LENGTH_CM}cm\n`,
  );

  const res = await client.execute(
    `SELECT id, title, weight_grams, width_cm, height_cm, length_cm
       FROM listings WHERE ${FALTANDO} ORDER BY created_at`,
  );

  console.log(`Anúncios ATIVOS sem dados de frete: ${res.rows.length}\n`);
  for (const r of res.rows as any[]) {
    console.log(
      `  ${String(r.title).slice(0, 46).padEnd(46)} ` +
        `peso=${r.weight_grams ?? 'null'} ${r.width_cm ?? 'null'}x${r.height_cm ?? 'null'}x${r.length_cm ?? 'null'}`,
    );
  }

  if (res.rows.length === 0) return console.log('\nNada a preencher.');
  if (!APPLY) {
    return console.log(
      `\n[dry-run] Nada alterado. Rode com --apply para preencher estes ${res.rows.length}.\n`,
    );
  }

  // COALESCE preserva qualquer medida que já esteja preenchida e válida:
  // só a dimensão ausente/zerada recebe o default.
  const r = await client.execute({
    sql: `
      UPDATE listings SET
        weight_grams = CASE WHEN weight_grams IS NULL OR weight_grams <= 0 THEN ? ELSE weight_grams END,
        width_cm     = CASE WHEN width_cm     IS NULL OR width_cm     <= 0 THEN ? ELSE width_cm     END,
        height_cm    = CASE WHEN height_cm    IS NULL OR height_cm    <= 0 THEN ? ELSE height_cm    END,
        length_cm    = CASE WHEN length_cm    IS NULL OR length_cm    <= 0 THEN ? ELSE length_cm    END,
        updated_at   = ?
      WHERE ${FALTANDO}`,
    args: [
      DEFAULT_WEIGHT_GRAMS,
      DEFAULT_WIDTH_CM,
      DEFAULT_HEIGHT_CM,
      DEFAULT_LENGTH_CM,
      // `mode: 'timestamp'` no schema = Unix em SEGUNDOS (não ms).
      Math.floor(Date.now() / 1000),
    ],
  });

  const resto = await client.execute(
    `SELECT COUNT(*) AS n FROM listings WHERE ${FALTANDO}`,
  );
  console.log(
    `\n✅ ${r.rowsAffected} anúncio(s) preenchido(s). Ativos ainda sem frete: ${(resto.rows[0] as any).n}\n`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
