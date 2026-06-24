/**
 * Reset limpo da taxonomia de categorias.
 *
 * Alinha a tabela `categories` com a lista canônica (id = slug), removendo as
 * categorias legadas (c1..c6). Para respeitar as FKs (RESTRICT), primeiro zera
 * `categoryId` em listings/community_posts que apontam para categorias que serão
 * removidas.
 *
 * Uso: npx tsx src/database/reset-categories.ts
 */
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { notInArray } from 'drizzle-orm';
import * as schema from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const db = drizzle(client, { schema });

const CANONICAL = [
  { id: 'miniaturas-diecast', name: 'Miniaturas & Diecast', slug: 'miniaturas-diecast', icon: '🏎️' },
  { id: 'cards-colecionaveis', name: 'Cards Colecionáveis', slug: 'cards-colecionaveis', icon: '🃏' },
  { id: 'action-figures', name: 'Action Figures & Statues', slug: 'action-figures', icon: '🦸' },
  { id: 'funko-pop', name: 'Funko Pop', slug: 'funko-pop', icon: '🎭' },
  { id: 'mangas-hqs', name: 'Mangás & HQs', slug: 'mangas-hqs', icon: '📚' },
];

const canonicalIds = CANONICAL.map((c) => c.id);

async function reset() {
  console.log('🧹 Liberando vínculos de categorias não-canônicas...');

  const freedListings = await db
    .update(schema.listings)
    .set({ categoryId: null })
    .where(notInArray(schema.listings.categoryId, canonicalIds))
    .returning({ id: schema.listings.id });
  console.log(`  ↪ listings desvinculados: ${freedListings.length}`);

  const freedPosts = await db
    .update(schema.communityPosts)
    .set({ categoryId: null })
    .where(notInArray(schema.communityPosts.categoryId, canonicalIds))
    .returning({ id: schema.communityPosts.id });
  console.log(`  ↪ community_posts desvinculados: ${freedPosts.length}`);

  console.log('🗑️  Removendo categorias legadas...');
  const removed = await db
    .delete(schema.categories)
    .where(notInArray(schema.categories.id, canonicalIds))
    .returning({ id: schema.categories.id });
  console.log(`  ↪ categorias removidas: ${removed.map((r) => r.id).join(', ') || '(nenhuma)'}`);

  console.log('🌱 Inserindo categorias canônicas...');
  for (const c of CANONICAL) {
    await db.insert(schema.categories).values(c).onConflictDoNothing();
    console.log(`  ✅ ${c.name} (${c.id})`);
  }

  const final = await db.select().from(schema.categories);
  console.log(`\n✔ Taxonomia final: ${final.length} categorias.`);
}

reset()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Erro no reset:', err);
    process.exit(1);
  });
