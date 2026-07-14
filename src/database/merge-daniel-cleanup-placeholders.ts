/**
 * One-off ops (14/07/2026): merge do usuário duplicado do Daniel + limpeza dos
 * placeholders órfãos do período do cutover Clerk (25/06–08/07).
 *
 * Contexto (diagnóstico em docs/diario/2026-07-08.md e sessão de 14/07):
 * - O Daniel existe DUAS vezes no Turso: `user_3Fasee…` (instância Clerk dev,
 *   nome/email reais, role admin, SEM dados pendurados) e `user_3GENW…`
 *   (instância prod — a que emite os JWTs hoje —, placeholder "Novo Usuário",
 *   com 1 anúncio + 1 endereço). O backfill falhou no UNIQUE de users.email.
 * - 7 placeholders restantes não existem em NENHUMA instância Clerk (deletados);
 *   2 deles são donos de 3 anúncios ativos (incl. o leilão Kaido House).
 *
 * O que o script faz, nesta ordem:
 *   1. Reatribui os anúncios dos usuários mortos para o Daniel prod (decisão 14/07).
 *   2. Apaga a linha dev do Daniel (libera o email único) — só se estiver sem refs.
 *   3. Corrige a linha prod do Daniel: nome/email reais + role admin.
 *   4. Apaga os 7 placeholders mortos — cada um só se estiver sem NENHUMA ref
 *      (FKs descobertas dinamicamente via PRAGMA, cobre chat/comunidade também).
 *
 * Idempotente e seguro: dry-run por padrão; nunca deleta usuário com dado
 * pendurado (evita o cascade apagar anúncio/leilão junto).
 *
 * Uso:
 *   npx tsx src/database/merge-daniel-cleanup-placeholders.ts           # dry-run
 *   npx tsx src/database/merge-daniel-cleanup-placeholders.ts --apply   # grava
 */
import { createClient, type Client } from '@libsql/client';
import * as dotenv from 'dotenv';

dotenv.config();

const APPLY = process.argv.includes('--apply');

// ─── Constantes da operação (confirmadas por leitura do Turso prod + Clerk em 14/07) ───
const DANIEL_DEV = 'user_3FaseeIWZk19c4mqQbEqihrXsBj'; // instância dev — apagar
const DANIEL_PROD = 'user_3GENW2BuDaChM4VY0hr1tNRFe2G'; // instância prod — manter
const DANIEL_NAME = 'Daniel Salgado';
const DANIEL_EMAIL = 'dansalgaado@gmail.com';

// Donos (deletados no Clerk) dos 3 anúncios ativos → reatribuir ao Daniel prod
const REASSIGN_LISTINGS_FROM = [
  'user_3FhK29Z4ufWvn5t3qQCeS0nY0eU', // Lexus LC 500 Matchbox
  'user_3GB3ye1kqneXDKZh3Z7OB4DJ2j8', // Kaido House (leilão) + Mini GT Acura
];

// Placeholders sem correspondente em nenhuma instância Clerk → apagar (se sem refs)
const DEAD_PLACEHOLDERS = [
  'user_39h69xlMv645c1WB5BpcXtKXJpV',
  'user_3FhK29Z4ufWvn5t3qQCeS0nY0eU',
  'user_3G8T2vztRjVT6ncpELD1IJqqhRL',
  'user_3G9ZHVNCD51QWRghlUiAhog8UBY',
  'user_3GB3ye1kqneXDKZh3Z7OB4DJ2j8',
  'user_3AqjnEyX18IEdnASBHF4gxiruB4',
  'user_3GCCvt4R2dA8LEA5O8MRHXdg8Dc',
];

type UserRef = { table: string; column: string };

/** Descobre todas as colunas do banco que têm FK apontando para users(id). */
async function discoverUserRefs(db: Client): Promise<UserRef[]> {
  const tables = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const refs: UserRef[] = [];
  for (const t of tables.rows) {
    const table = String(t.name);
    if (table === 'users') continue;
    const fks = await db.execute(`PRAGMA foreign_key_list(${JSON.stringify(table)})`);
    for (const fk of fks.rows) {
      if (fk.table === 'users') refs.push({ table, column: String(fk.from) });
    }
  }
  return refs;
}

/** Conta quantas linhas ainda referenciam o usuário (em todas as FKs). */
async function countRefs(db: Client, refs: UserRef[], userId: string): Promise<string[]> {
  const found: string[] = [];
  for (const { table, column } of refs) {
    const r = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM ${JSON.stringify(table)} WHERE ${JSON.stringify(column)} = ?`,
      args: [userId],
    });
    const n = Number(r.rows[0].n);
    if (n > 0) found.push(`${table}.${column}=${n}`);
  }
  return found;
}

/**
 * Wallet vazia (todos os saldos 0 e nenhuma transação) não bloqueia a deleção —
 * toda conta ganha uma no provisionamento e o cascade a remove sem perda.
 */
async function hasEmptyWallet(db: Client, userId: string): Promise<boolean> {
  const w = await db.execute({
    sql: 'SELECT id, balance_in_cents + pending_in_cents + withdrawal_pending_in_cents AS total FROM wallets WHERE user_id = ?',
    args: [userId],
  });
  if (!w.rows.length) return false;
  if (Number(w.rows[0].total) !== 0) return false;
  const tx = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM wallet_transactions WHERE wallet_id = ?',
    args: [w.rows[0].id],
  });
  return Number(tx.rows[0].n) === 0;
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL não configurada no .env');
  const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

  console.log(`Banco: ${url}`);
  console.log(`Modo:  ${APPLY ? 'APLICAR (grava no banco)' : 'DRY-RUN (nada será gravado)'}\n`);

  const refs = await discoverUserRefs(db);
  console.log(
    `FKs → users descobertas: ${refs.map((r) => `${r.table}.${r.column}`).join(', ')}\n`,
  );
  const now = Math.floor(Date.now() / 1000);

  // ── 1. Reatribuir anúncios dos usuários mortos ao Daniel prod ──────────────
  for (const from of REASSIGN_LISTINGS_FROM) {
    const r = await db.execute({
      sql: 'SELECT id, title FROM listings WHERE seller_id = ?',
      args: [from],
    });
    if (!r.rows.length) {
      console.log(`1) ${from}: sem anúncios (já reatribuído?) — ok`);
      continue;
    }
    for (const l of r.rows) console.log(`1) ✏️  anúncio "${l.title}" → ${DANIEL_PROD}`);
    if (APPLY) {
      await db.execute({
        sql: 'UPDATE listings SET seller_id = ?, updated_at = ? WHERE seller_id = ?',
        args: [DANIEL_PROD, now, from],
      });
    }
  }

  // ── 2. Apagar a linha dev do Daniel (libera o email) ───────────────────────
  const dev = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [DANIEL_DEV] });
  if (dev.rows.length) {
    let pend = await countRefs(db, refs, DANIEL_DEV);
    if (await hasEmptyWallet(db, DANIEL_DEV)) {
      pend = pend.filter((x) => !x.startsWith('wallets.user_id'));
    }
    if (pend.length) {
      throw new Error(`Linha dev do Daniel tem dados pendurados (${pend.join(', ')}) — abortando.`);
    }
    console.log(`2) 🗑️  apagar usuário dev ${DANIEL_DEV} (sem refs)`);
    if (APPLY) await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [DANIEL_DEV] });
  } else {
    console.log(`2) usuário dev ${DANIEL_DEV} já não existe — ok`);
  }

  // ── 3. Corrigir a linha prod do Daniel ─────────────────────────────────────
  const prod = await db.execute({
    sql: 'SELECT name, email, role FROM users WHERE id = ?',
    args: [DANIEL_PROD],
  });
  if (!prod.rows.length) throw new Error(`Usuário prod ${DANIEL_PROD} não encontrado — abortando.`);
  const p = prod.rows[0];
  if (p.name === DANIEL_NAME && p.email === DANIEL_EMAIL && p.role === 'admin') {
    console.log(`3) usuário prod já corrigido — ok`);
  } else {
    console.log(
      `3) ✏️  ${DANIEL_PROD}: name="${p.name}"→"${DANIEL_NAME}" email="${p.email}"→"${DANIEL_EMAIL}" role=${p.role}→admin`,
    );
    if (APPLY) {
      await db.execute({
        sql: "UPDATE users SET name = ?, email = ?, role = 'admin', updated_at = ? WHERE id = ?",
        args: [DANIEL_NAME, DANIEL_EMAIL, now, DANIEL_PROD],
      });
    }
  }

  // ── 4. Apagar placeholders mortos (só se sem NENHUMA ref) ──────────────────
  for (const id of DEAD_PLACEHOLDERS) {
    const u = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [id] });
    if (!u.rows.length) {
      console.log(`4) ${id}: já não existe — ok`);
      continue;
    }
    // No dry-run os anúncios ainda não foram movidos — considerar a reatribuição pendente.
    let pend = (await countRefs(db, refs, id)).filter(
      (x) => APPLY || !(REASSIGN_LISTINGS_FROM.includes(id) && x.startsWith('listings.seller_id')),
    );
    if (await hasEmptyWallet(db, id)) {
      pend = pend.filter((x) => !x.startsWith('wallets.user_id'));
    }
    if (pend.length) {
      console.log(`4) ⏭️  ${id}: ainda tem refs (${pend.join(', ')}) — NÃO será apagado`);
      continue;
    }
    console.log(`4) 🗑️  apagar placeholder ${id}`);
    if (APPLY) await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] });
  }

  console.log(`\n${APPLY ? '✅ Aplicado.' : '➡️  Dry-run OK. Rode com --apply para gravar.'}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  });
