/**
 * Pausa (ou retoma) os leilões ativos.
 *
 * Por que existe: o lance é garantido por pré-autorização no cartão, e o cartão
 * está fechado enquanto a Pagar.me reprova as cobranças. Com o relógio correndo,
 * leilões encerrariam sem que ninguém pudesse dar lance — o vencedor seria quem
 * já estava na frente por acaso, e os demais nem teriam chance.
 *
 * O leilão pausado CONTINUA `active`: segue na vitrine e na aba de lances. O que
 * muda é que o cron não o encerra e o lance é recusado com mensagem própria.
 *
 * A pausa guarda quanto tempo FALTAVA. Ao retomar, `endsAt` vira `agora + o que
 * faltava` — o leilão volta com o tempo que tinha, não com o resto de um relógio
 * que continuou correndo no escuro.
 *
 *   npx ts-node --transpile-only scripts/pausar-leiloes.ts pausar
 *   npx ts-node --transpile-only scripts/pausar-leiloes.ts pausar  --aplicar
 *   npx ts-node --transpile-only scripts/pausar-leiloes.ts retomar --aplicar
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Data-limite distante, só para o cron não topar com o leilão enquanto pausado.
// O valor real de `endsAt` é recalculado na retomada a partir do tempo restante.
const LIMBO = Math.floor(new Date('2099-01-01T00:00:00Z').getTime() / 1000);

const dur = (ms: number) => {
  const min = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  return `${d}d ${h}h ${min % 60}m`;
};

(async () => {
  const acao = process.argv[2];
  const aplicar = process.argv.includes('--aplicar');
  if (!['pausar', 'retomar'].includes(acao)) {
    console.error('Uso: pausar-leiloes.ts <pausar|retomar> [--aplicar]');
    process.exit(1);
  }
  console.log(aplicar ? 'MODO: aplicando\n' : 'MODO: simulação (use --aplicar)\n');
  const agora = Math.floor(Date.now() / 1000);

  if (acao === 'pausar') {
    // Vendedor APTO fica de fora: o leilão dele funciona, pausar seria tirar do
    // ar quem já pode receber. Isto torna o script seguro de rodar de novo
    // enquanto a fila de recadastro anda — cada rodada pausa só quem ainda não
    // voltou, sem desfazer o que a retomada automática já liberou.
    const r = await client.execute(`
      SELECT a.id, a.ends_at, l.title,
             (SELECT COUNT(*) FROM bids b WHERE b.auction_id = a.id) lances
      FROM auctions a
      JOIN listings l ON l.id = a.listing_id
      LEFT JOIN seller_profiles sp ON sp.user_id = l.seller_id
      WHERE a.status = 'active' AND a.paused_at IS NULL AND a.ends_at IS NOT NULL
        AND NOT (sp.pagarme_recipient_id IS NOT NULL AND sp.can_receive = 1)
      ORDER BY a.ends_at`);

    if (r.rows.length === 0) {
      console.log('Nenhum leilão ativo para pausar.');
      return;
    }
    for (const a of r.rows as any[]) {
      const restanteMs = (Number(a.ends_at) - agora) * 1000;
      console.log(
        `  ${dur(restanteMs).padStart(12)} restantes | ${String(a.lances).padStart(2)} lance(s) | ${String(a.title).trim().slice(0, 45)}`,
      );
      if (!aplicar) continue;
      await client.execute({
        sql: `UPDATE auctions
              SET paused_at = ?, paused_remaining_ms = ?, ends_at = ?, updated_at = ?
              WHERE id = ? AND status = 'active' AND paused_at IS NULL`,
        args: [agora, Math.max(0, restanteMs), LIMBO, agora, a.id],
      });
    }
    console.log(`\n${r.rows.length} leilão(ões) ${aplicar ? 'pausados' : 'a pausar'}.`);
    return;
  }

  // ── retomar ──────────────────────────────────────────────────────────────
  const r = await client.execute(`
    SELECT a.id, a.paused_remaining_ms, l.title
    FROM auctions a JOIN listings l ON l.id = a.listing_id
    WHERE a.paused_at IS NOT NULL`);

  if (r.rows.length === 0) {
    console.log('Nenhum leilão pausado.');
    return;
  }
  for (const a of r.rows as any[]) {
    const restanteMs = Number(a.paused_remaining_ms ?? 0);
    const novoFim = agora + Math.round(restanteMs / 1000);
    console.log(
      `  volta com ${dur(restanteMs)} → encerra ${new Date(novoFim * 1000).toLocaleString('pt-BR')} | ${String(a.title).trim().slice(0, 40)}`,
    );
    if (!aplicar) continue;
    await client.execute({
      sql: `UPDATE auctions
            SET ends_at = ?, paused_at = NULL, paused_remaining_ms = NULL, updated_at = ?
            WHERE id = ?`,
      args: [novoFim, agora, a.id],
    });
  }
  console.log(`\n${r.rows.length} leilão(ões) ${aplicar ? 'retomados' : 'a retomar'}.`);
})();
