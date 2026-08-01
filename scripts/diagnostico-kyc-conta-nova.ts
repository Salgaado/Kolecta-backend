/**
 * Responde UMA pergunta: o 401 do `kyc_link` está travando o KYC, ou só sujando
 * a tela?
 *
 * Desde a virada para a conta nova (31/07) o `POST /recipients` passa e o
 * `POST /recipients/{id}/kyc_link` volta `401 "IP de origem não autorizado"` —
 * a allowlist de operações sensíveis não foi replicada. O vendedor vê erro
 * vermelho, mas o recebedor É criado. A dúvida cara é se ele consegue concluir
 * a prova de vida mesmo assim (a Pagar.me tem o fluxo dela por e-mail) ou se
 * está todo mundo empilhando em `registration`.
 *
 * O banco sabe. Recebedor que chegou a `active` DEPOIS da virada é prova de que
 * o KYC fecha sem o nosso link — e cada um parado em `registration` há dias é
 * um vendedor que não vende.
 *
 * Só leitura.
 *   npx ts-node --transpile-only scripts/diagnostico-kyc-conta-nova.ts
 *   npx ts-node --transpile-only scripts/diagnostico-kyc-conta-nova.ts 2026-07-30
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/** Virada de credenciais para a conta nova (Fase 3). Sobrescrevível no argv. */
const VIRADA_PADRAO = '2026-07-31';

const HORAS = 3600;
const DIAS = 24 * HORAS;

function parseCorte(arg?: string): { iso: string; unix: number } {
  const iso = arg ?? VIRADA_PADRAO;
  // Meia-noite em -03:00, que é como as datas do projeto são lidas.
  const d = new Date(`${iso}T00:00:00-03:00`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Data inválida: "${iso}". Use YYYY-MM-DD.`);
  }
  return { iso, unix: Math.floor(d.getTime() / 1000) };
}

function humanizar(segundos: number): string {
  if (segundos < HORAS) return `${Math.floor(segundos / 60)}min`;
  if (segundos < DIAS) return `${Math.floor(segundos / HORAS)}h`;
  return `${Math.floor(segundos / DIAS)}d`;
}

(async () => {
  const corte = parseCorte(process.argv[2]);
  const agora = Math.floor(Date.now() / 1000);

  const rows = (
    await client.execute({
      sql: `
        SELECT sp.user_id,
               sp.pagarme_recipient_id     AS recipient_id,
               sp.pagarme_recipient_status AS status,
               sp.can_receive,
               sp.kyc_updated_at,
               COALESCE(u.name, '?')       AS nome,
               u.email
          FROM seller_profiles sp
          LEFT JOIN users u ON u.id = sp.user_id
         WHERE sp.pagarme_recipient_id IS NOT NULL
           AND sp.kyc_updated_at >= ?
         ORDER BY sp.kyc_updated_at`,
      args: [corte.unix],
    })
  ).rows as any[];

  console.log(
    `\n📋 Recebedores tocados desde ${corte.iso} (virada da conta): ${rows.length}\n`,
  );

  if (rows.length === 0) {
    console.log(
      'Nenhum. Ou a data de corte está errada, ou ninguém refez o cadastro ainda.',
    );
    await client.close();
    return;
  }

  // ── Distribuição por status ────────────────────────────────────────────────
  const porStatus = new Map<string, number>();
  rows.forEach((r) => {
    const s = (r.status as string) ?? 'null';
    porStatus.set(s, (porStatus.get(s) ?? 0) + 1);
  });

  console.log('Por status:');
  [...porStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([status, n]) => {
      const pct = ((n / rows.length) * 100).toFixed(0);
      console.log(`  ${status.padEnd(14)} ${String(n).padStart(3)}  (${pct}%)`);
    });

  // ── O veredito ─────────────────────────────────────────────────────────────
  const ativos = rows.filter((r) => r.status === 'active');
  const travados = rows.filter((r) =>
    ['registration', 'affiliation'].includes(r.status),
  );

  console.log('\n' + '─'.repeat(64));
  if (ativos.length > 0) {
    console.log(
      `\n✅ ${ativos.length} recebedor(es) chegaram a ACTIVE depois da virada.\n` +
        `   O nosso link de KYC não funcionou uma única vez nesse período, então\n` +
        `   a prova de vida FECHA sem ele. O 401 suja a tela, não trava o KYC.`,
    );
  } else {
    console.log(
      `\n⛔ NENHUM recebedor chegou a ACTIVE depois da virada.\n` +
        `   Não há evidência de que o KYC feche sem o nosso link. Trate o 401\n` +
        `   como BLOQUEANTE até a allowlist ser corrigida.`,
    );
  }

  if (travados.length > 0) {
    console.log(
      `\n⏳ ${travados.length} parado(s) em registration/affiliation:\n`,
    );
    travados.forEach((r) => {
      const parado = humanizar(agora - Number(r.kyc_updated_at));
      console.log(
        `   ${String(r.nome).slice(0, 26).padEnd(28)} ${String(r.email ?? '—').padEnd(32)} ` +
          `${String(r.status).padEnd(13)} há ${parado}`,
      );
    });
    console.log(
      `\n   Quem passa de ~48h aqui provavelmente não recebeu (ou não achou) o\n` +
        `   convite da Pagar.me — vale contato manual.`,
    );
  }

  const problema = rows.filter((r) =>
    ['refused', 'suspended', 'blocked'].includes(r.status),
  );
  if (problema.length > 0) {
    console.log(`\n🚨 ${problema.length} em estado que exige ação do vendedor:`);
    problema.forEach((r) =>
      console.log(`   ${r.nome} <${r.email}> — ${r.status}`),
    );
  }

  console.log('');
  await client.close();
})().catch((err) => {
  console.error('Falhou:', err?.message ?? err);
  process.exit(1);
});
