/**
 * Limpeza (pendências 1.1) — reverte os fundadores da faixa da LANDING (51..100)
 * que foram concedidos AUTOMATICAMENTE pela regra antiga (auto-grant na leitura).
 * A seleção dos 100 é curada pela equipe; estes números não foram escolhidos.
 *
 * Cada um volta a CANDIDATO: founder_number=null, founder_status='qualified',
 * founder_since=null, e os créditos de destaque são removidos. Convites (1..50)
 * NÃO são tocados (foram resgatados legitimamente).
 *
 * Dry-run por padrão (só lista). Para aplicar:
 *   npx ts-node --transpile-only scripts/reset-auto-founders.ts --apply
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const LANDING_MIN = 51;
const LANDING_MAX = 100;
const APPLY = process.argv.includes('--apply');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
  const res = await client.execute({
    sql: `
      select sp.user_id, sp.founder_number, sp.founder_status,
             u.name, u.email
      from seller_profiles sp
      left join users u on u.id = sp.user_id
      where sp.founder_number between ? and ?
      order by sp.founder_number
    `,
    args: [LANDING_MIN, LANDING_MAX],
  });

  const rows = res.rows as unknown as Array<{
    user_id: string;
    founder_number: number;
    founder_status: string;
    name: string | null;
    email: string | null;
  }>;

  console.log(
    `\nFundadores na faixa landing ${LANDING_MIN}..${LANDING_MAX}: ${rows.length}\n`,
  );
  for (const r of rows) {
    console.log(
      `  #${String(r.founder_number).padStart(3, '0')} ${r.founder_status.padEnd(9)} ${r.name ?? '(sem nome)'} <${r.email ?? '?'}> (${r.user_id})`,
    );
  }

  if (rows.length === 0) {
    console.log('\nNada a reverter.');
    return;
  }

  if (!APPLY) {
    console.log(
      `\n[dry-run] Nenhuma alteração feita. Rode com --apply para reverter estes ${rows.length} a candidato.\n`,
    );
    return;
  }

  const ids = rows.map((r) => r.user_id);
  const placeholders = ids.map(() => '?').join(',');

  // Reverte perfil → candidato (qualified) e remove créditos de destaque.
  await client.execute({
    sql: `
      update seller_profiles
         set founder_number = null,
             founder_status = 'qualified',
             founder_since = null,
             founder_last_active_listing_at = null,
             updated_at = ?
       where user_id in (${placeholders})
    `,
    // `mode: 'timestamp'` no schema = Unix em SEGUNDOS (não ms).
    args: [Math.floor(Date.now() / 1000), ...ids],
  });
  await client.execute({
    sql: `delete from founder_credits where user_id in (${placeholders})`,
    args: ids,
  });

  console.log(
    `\n✅ Revertidos ${rows.length} perfis a candidato (qualified) e créditos removidos.\n`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
