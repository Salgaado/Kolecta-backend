/**
 * Seed de Desenvolvimento — insere os usuários mock no Turso local.
 *
 * Uso: npx tsx src/database/seed-dev.ts
 */
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const db = drizzle(client, { schema });

const devUsers = [
  {
    id: 'seller-001',
    email: 'vendedor@email.com',
    name: 'Coleção Turbo',
    role: 'user',
  },
  {
    id: 'buyer-001',
    email: 'joao@email.com',
    name: 'João Silva',
    role: 'user',
  },
  {
    id: 'admin-001',
    email: 'admin@kolecta.com.br',
    name: 'Admin Kolecta',
    role: 'admin',
  },
];

const mockCategories = [
  {
    id: 'c1',
    name: 'Carrinhos & Miniaturas',
    slug: 'carrinhos-miniaturas',
    icon: '🏎️',
  },
  { id: 'c2', name: 'Funko Pop', slug: 'funko-pop', icon: '🎭' },
  {
    id: 'c3',
    name: 'Cards Colecionáveis',
    slug: 'cards-colecionaveis',
    icon: '🃏',
  },
  { id: 'c4', name: 'Action Figures', slug: 'action-figures', icon: '🦸' },
  { id: 'c5', name: 'Modelismo', slug: 'modelismo', icon: '✈️' },
  { id: 'c6', name: 'Vintage & Retrô', slug: 'vintage-retro', icon: '📻' },
];

async function seed() {
  console.log('🌱 Inserindo usuários de desenvolvimento...');

  for (const user of devUsers) {
    try {
      await db
        .insert(schema.users)
        .values({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        })
        .onConflictDoNothing();
      console.log(`  ✅ ${user.role}: ${user.name} (${user.id})`);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        console.log(`  ⏭️  ${user.name} já existe.`);
      } else {
        console.error(`  ❌ Erro em ${user.name}:`, err.message);
      }
    }
  }

  console.log('🌱 Inserindo categorias...');
  for (const cat of mockCategories) {
    try {
      await db
        .insert(schema.categories)
        .values({
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          icon: cat.icon,
        })
        .onConflictDoNothing();
      console.log(`  ✅ Categoria: ${cat.name}`);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        console.log(`  ⏭️  Categoria ${cat.name} já existe.`);
      } else {
        console.error(`  ❌ Erro em ${cat.name}:`, err.message);
      }
    }
  }

  console.log('✅ Seed concluído!');
  process.exit(0);
}

seed();
