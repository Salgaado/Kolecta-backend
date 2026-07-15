/**
 * Gera os 50 códigos de convite do evento presencial (Programa Membro Fundador).
 * Cada código reserva um número da faixa 1..50 (a landing só usa 51+).
 * Ver docs/PLAN-programa-fundadores.md (T3).
 *
 * Idempotente: só insere números/códigos que ainda não existem. Não mexe em
 * códigos já resgatados.
 *
 * Uso (instância vem das envs do Turso):
 *   npx tsx src/database/seed-founder-invites.ts --dry   # só mostra
 *   npx tsx src/database/seed-founder-invites.ts         # aplica
 */
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

const DRY = process.argv.includes('--dry');
const INVITE_MIN = 1;
const INVITE_MAX = 50;

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error('❌ TURSO_DATABASE_URL não configurada.');
  process.exit(1);
}
console.log(
  `Banco: ${url}\nModo: ${DRY ? 'DRY-RUN (nada será gravado)' : 'APLICAR'}\n`,
);

const db = drizzle(
  createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }),
  { schema },
);

/** #014 -> "KOLECTA-FND-014" */
function codeFor(n: number): string {
  return `KOLECTA-FND-${String(n).padStart(3, '0')}`;
}

async function main() {
  const existing = await db.select().from(schema.founderInviteCodes);
  const takenNumbers = new Set(existing.map((c) => c.founderNumber));
  const takenCodes = new Set(existing.map((c) => c.code));

  console.log(`Códigos já existentes: ${existing.length}`);

  let created = 0;
  for (let n = INVITE_MIN; n <= INVITE_MAX; n++) {
    const code = codeFor(n);
    if (takenNumbers.has(n) || takenCodes.has(code)) {
      continue; // já existe — não duplica nem sobrescreve resgatados
    }

    console.log(`  ${DRY ? '[dry] ' : '➕ '}#${String(n).padStart(3, '0')} → ${code}`);
    if (!DRY) {
      await db
        .insert(schema.founderInviteCodes)
        .values({ code, founderNumber: n });
      created++;
    }
  }

  console.log(
    `\n${DRY ? 'Seriam criados' : 'Criados'}: ${created} código(s). Total da faixa: ${INVITE_MAX - INVITE_MIN + 1}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro:', err);
    process.exit(1);
  });
