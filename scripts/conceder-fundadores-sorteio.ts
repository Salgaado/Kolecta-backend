/**
 * Concede o selo de Membro Fundador aos 10 vendedores sorteados em 25/07/2026,
 * com os números 1..10 saídos do sorteio (Fisher-Yates + crypto.randomInt).
 *
 * POR QUE PELO RESGATE DE CONVITE, E NÃO PELO grantFounder:
 * `grantFounder` só aceita 0 (a casa) ou a faixa da landing 51..100 — a faixa
 * 1..50 é dos códigos do evento. Como a decisão do dono foi dar 1..10 a estes
 * vendedores, o caminho honesto é RESGATAR os convites KOLECTA-FND-001..010 em
 * nome deles: o número sai do próprio código, os convites ficam marcados como
 * usados (nenhum código morto circulando no evento) e todo o resto do efeito —
 * founderStatus 'active', founderSince, créditos de destaque — é exatamente o
 * mesmo do fluxo normal, porque é o mesmo método.
 *
 * Simula por padrão. Para aplicar:
 *   npx ts-node --transpile-only scripts/conceder-fundadores-sorteio.ts --aplicar
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import * as schema from '../src/database/schema';
import { FounderService } from '../src/founder/founder.service';

const APLICAR = process.argv.includes('--aplicar');

/** Resultado do sorteio de 25/07/2026 (10 candidatos verificados no banco). */
const CONCESSOES = [
  { numero: 1, code: 'KOLECTA-FND-001', nome: 'Alfredo Mathis', userId: 'user_3Gs8j7HKfYtW9cnO43jgqKgjScN' },
  { numero: 2, code: 'KOLECTA-FND-002', nome: 'João Carone (GT RACE)', userId: 'user_3GYgYMRbE4CTXExrjY0107StaPw' },
  { numero: 3, code: 'KOLECTA-FND-003', nome: 'Luiz Alberto Zaffani', userId: 'user_3GcOMcLSP51pegPpJfGP2r1gqXV' },
  { numero: 4, code: 'KOLECTA-FND-004', nome: 'Jean Nascimento (RODA RARA)', userId: 'user_3GrzV0IyauW0EDiaZVNqmo4Fdmq' },
  { numero: 5, code: 'KOLECTA-FND-005', nome: 'Escala Miniaturas (Henrique Loureiro)', userId: 'user_3GsGMG65DFJMxxA0SQcCGac30tM' },
  { numero: 6, code: 'KOLECTA-FND-006', nome: 'Rodrigo Rodrigues (RA/AP. Diecast)', userId: 'user_3GYpmIkIk7tlzbdEG5vxKxjGncu' },
  { numero: 7, code: 'KOLECTA-FND-007', nome: 'Raquel Ferreira dos Santos (Besttoysale)', userId: 'user_3GkNr6TqQ5C3wZ2W3fKNM4cUtXS' },
  { numero: 8, code: 'KOLECTA-FND-008', nome: 'xCL TCG', userId: 'user_3GbUK8Uc4a9v4jNh9wGFpt1W1Hy' },
  { numero: 9, code: 'KOLECTA-FND-009', nome: "Julio Cesar (Bucky's Collection)", userId: 'user_3GvoAbdltrlM56sO6A49K8IhcLk' },
  { numero: 10, code: 'KOLECTA-FND-010', nome: 'Jose Drumond', userId: 'user_3H04HY4mt9O2suGeObg4UUFrGkZ' },
];

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const db = drizzle(client, { schema });
const founder = new FounderService(db as any);

(async () => {
  console.log(`Banco: ${process.env.TURSO_DATABASE_URL}`);
  console.log(APLICAR ? '\n>>> MODO APLICAR <<<\n' : '\n>>> simulação (use --aplicar para valer) <<<\n');

  // ── Conferências antes de tocar em qualquer coisa ──────────────────────────
  let bloqueado = false;
  for (const c of CONCESSOES) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, c.userId));
    const [perfil] = await db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, c.userId));
    const [convite] = await db
      .select()
      .from(schema.founderInviteCodes)
      .where(eq(schema.founderInviteCodes.code, c.code));

    const problemas: string[] = [];
    if (!user) problemas.push('usuário não existe');
    if (!convite) problemas.push(`convite ${c.code} não existe`);
    // O número vem do CÓDIGO, não daqui: se divergir, o sorteio não seria respeitado.
    if (convite && convite.founderNumber !== c.numero) {
      problemas.push(`convite ${c.code} vale #${convite.founderNumber}, esperado #${c.numero}`);
    }
    if (convite?.redeemedByUserId) problemas.push(`convite ${c.code} já resgatado`);
    if (perfil?.founderNumber != null) problemas.push(`já é fundador #${perfil.founderNumber}`);

    console.log(
      `#${String(c.numero).padStart(2)} ${c.nome}\n` +
        `      ${user?.name ?? '???'} | ${user?.email ?? '-'}\n` +
        `      ${problemas.length ? '❌ ' + problemas.join('; ') : '✅ pronto para receber ' + c.code}`,
    );
    if (problemas.length) bloqueado = true;
  }

  if (bloqueado) {
    console.log('\nNada foi aplicado: resolva os itens marcados acima primeiro.');
    return;
  }
  if (!APLICAR) {
    console.log('\nSimulação OK. Rode de novo com --aplicar para conceder.');
    return;
  }

  // ── Aplicação ──────────────────────────────────────────────────────────────
  console.log('');
  for (const c of CONCESSOES) {
    const perfil = await founder.redeemInviteCode(c.userId, c.code);
    console.log(
      `✅ #${String(perfil.founderNumber).padStart(2)} ${c.nome} → ${perfil.founderStatus} desde ${perfil.founderSince?.toISOString?.() ?? perfil.founderSince}`,
    );
  }

  // ── Verificação final ──────────────────────────────────────────────────────
  const fundadores = await client.execute(`
    SELECT sp.founder_number, sp.founder_status, u.name, u.email,
           (SELECT credits_total FROM founder_credits fc WHERE fc.user_id = sp.user_id) creditos
    FROM seller_profiles sp JOIN users u ON u.id = sp.user_id
    WHERE sp.founder_number IS NOT NULL ORDER BY sp.founder_number
  `);
  console.log(`\n=== fundadores no banco: ${fundadores.rows.length}`);
  for (const f of fundadores.rows as any[]) {
    console.log(`  #${f.founder_number} | ${f.founder_status} | ${f.creditos ?? 0} créditos | ${f.name} | ${f.email}`);
  }

  const livres = await client.execute(
    `SELECT COUNT(*) n FROM founder_invite_codes WHERE redeemed_by_user_id IS NULL`,
  );
  console.log(`\nconvites de evento ainda livres: ${(livres.rows[0] as any).n} (esperado 40)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
