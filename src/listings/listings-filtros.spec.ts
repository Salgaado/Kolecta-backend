/**
 * Vitrine pública contra um SQLite de verdade, em memória.
 *
 * `GET /api/listings` é o endpoint que alimenta home, categoria e busca, e é
 * onde o projeto já se queimou duas vezes: uma com coluna no schema sem `push`
 * (500 na listagem inteira) e outra com SQL que o banco recusava. Mock de
 * Drizzle não pega nenhum dos dois — então aqui as tabelas saem do PRÓPRIO
 * schema e a consulta roda de ponta a ponta.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../database/schema';
import { ListingsService } from './listings.service';
import type { FounderService } from '../founder/founder.service';

/** CREATE TABLE derivado do schema — nunca descola das colunas reais. */
function createTableSql(tabela: SQLiteTable): string {
  const cfg = getTableConfig(tabela);
  const colunas = cfg.columns.map((c) => {
    const tipo = c.getSQLType();
    return `"${c.name}" ${tipo}${c.primary ? ' primary key' : ''}`;
  });
  return `create table "${cfg.name}" (${colunas.join(', ')})`;
}

describe('ListingsService.findAll — filtros da vitrine', () => {
  let client: Client;
  let service: ListingsService;

  const agora = Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });

    for (const t of [
      schema.users,
      schema.sellerProfiles,
      schema.categories,
      schema.listings,
      schema.auctions,
      schema.bids,
    ]) {
      await client.execute(createTableSql(t as SQLiteTable));
    }

    service = new ListingsService(
      db as any,
      {} as FounderService,
      new EventEmitter2(),
    );

    await client.batch([
      `insert into users (id, email, name, avatar_url, role, created_at, updated_at)
       values ('s1','a@a','Daniel','https://clerk/daniel.png','user',${agora},${agora})`,
      `insert into users (id, email, name, role, created_at, updated_at)
       values ('s2','b@b','Culture TCG','user',${agora},${agora})`,
      `insert into seller_profiles (id, user_id, store_name, avatar_url, founder_status, can_receive, can_withdraw, is_verified, stripe_charges_enabled, stripe_payouts_enabled, created_at, updated_at)
       values ('p1','s1','Escala Miniaturas','https://r2/loja.png','active',0,0,0,0,0,${agora},${agora})`,
      `insert into categories (id, name, slug, created_at, updated_at)
       values ('c-mini','Miniaturas','miniaturas-diecast',${agora},${agora})`,
      `insert into categories (id, name, slug, parent_id, created_at, updated_at)
       values ('c-mini-64','Escala 1:64','escala-164','c-mini',${agora},${agora})`,
      `insert into categories (id, name, slug, created_at, updated_at)
       values ('c-cards','Cards','cards-colecionaveis',${agora},${agora})`,
    ]);

    const anuncio = (
      id: string,
      dados: Record<string, string | number | null>,
    ) => {
      const base: Record<string, string | number | null> = {
        seller_id: 's1',
        title: `Anúncio ${id}`,
        condition: 'novo',
        type: 'direct',
        status: 'active',
        created_at: agora,
        updated_at: agora,
        ...dados,
      };
      const cols = ['id', ...Object.keys(base)];
      const vals = [
        `'${id}'`,
        ...Object.values(base).map((v) =>
          v === null ? 'null' : typeof v === 'number' ? v : `'${v}'`,
        ),
      ];
      return `insert into listings (${cols.map((c) => `"${c}"`).join(',')}) values (${vals.join(',')})`;
    };

    await client.batch([
      anuncio('L1', {
        title: 'Miniatura Ferrari 1:64',
        category_id: 'c-mini',
        price_in_cents: 5000,
        condition: 'novo',
      }),
      anuncio('L2', {
        title: 'Carta Pokémon Charizard',
        category_id: 'c-cards',
        price_in_cents: 30000,
        condition: 'usado',
        seller_id: 's2',
      }),
      anuncio('L3', {
        title: 'Hot Wheels raro',
        category_id: 'c-mini-64',
        price_in_cents: 15000,
        condition: 'lacrado',
      }),
      anuncio('L4', {
        title: 'Leilão de miniatura antiga',
        category_id: 'c-mini',
        price_in_cents: null,
        type: 'auction',
        condition: 'usado',
      }),
      anuncio('L5', {
        title: 'Rascunho que ninguém vê',
        category_id: 'c-mini',
        price_in_cents: 100,
        status: 'draft',
      }),
      `insert into auctions (id, listing_id, starting_bid_in_cents, min_increment_in_cents, duration_hours, anti_sniper, status, created_at, updated_at)
       values ('a1','L4',20000,1000,48,1,'active',${agora},${agora})`,
    ]);
  });

  afterAll(() => client?.close());

  const ids = async (filtros: Parameters<ListingsService['findAll']>[0]) => {
    const { items } = await service.findAll(filtros);
    return items.map((i) => i.id).sort();
  };

  it('só mostra o que está ativo', async () => {
    const { items, total } = await service.findAll({ limit: 50 });
    expect(items.map((i) => i.id).sort()).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(total).toBe(4);
  });

  it('filtra por categoria, por id ou por slug', async () => {
    await expect(ids({ categoria: 'c-cards' })).resolves.toEqual(['L2']);
    await expect(ids({ categoria: 'cards-colecionaveis' })).resolves.toEqual([
      'L2',
    ]);
  });

  it('categoria raiz traz junto as subcategorias', async () => {
    // L3 está em "Escala 1:64", pendurada em "Miniaturas".
    await expect(ids({ categoria: 'miniaturas-diecast' })).resolves.toEqual([
      'L1',
      'L3',
      'L4',
    ]);
  });

  it('filtra por condição, aceitando mais de uma', async () => {
    await expect(ids({ condicoes: ['lacrado'] })).resolves.toEqual(['L3']);
    await expect(ids({ condicoes: ['novo', 'lacrado'] })).resolves.toEqual([
      'L1',
      'L3',
    ]);
  });

  it('filtra por faixa de preço', async () => {
    await expect(ids({ precoMin: 10000, precoMax: 40000 })).resolves.toEqual([
      'L2',
      'L3',
      'L4',
    ]);
  });

  it('usa o lance do leilão como preço, já que ele não tem priceInCents', async () => {
    // Sem o COALESCE, o leilão sumiria de qualquer filtro de preço.
    await expect(ids({ precoMin: 19000, precoMax: 21000 })).resolves.toEqual([
      'L4',
    ]);
  });

  it('filtra por tipo', async () => {
    await expect(ids({ tipo: 'auction' })).resolves.toEqual(['L4']);
  });

  it('busca ignorando acento e caixa', async () => {
    await expect(ids({ q: 'pokemon' })).resolves.toEqual(['L2']);
    // L1 e L4 pelo título; L3 porque a loja se chama "Escala Miniaturas" e o
    // nome do vendedor faz parte do que a busca varre.
    await expect(ids({ q: 'MINIATURA' })).resolves.toEqual(['L1', 'L3', 'L4']);
  });

  it('combina busca com categoria', async () => {
    await expect(
      ids({ q: 'charizard', categoria: 'miniaturas-diecast' }),
    ).resolves.toEqual([]);
    await expect(
      ids({ q: 'ferrari', categoria: 'miniaturas-diecast' }),
    ).resolves.toEqual(['L1']);
  });

  it('pagina com total coerente com o filtro', async () => {
    // c-mini + a subcategoria dela: L1, L3 e L4.
    const p1 = await service.findAll({ categoria: 'c-mini', limit: 1 });
    expect(p1.items).toHaveLength(1);
    expect(p1.total).toBe(3);

    const p2 = await service.findAll({
      categoria: 'c-mini',
      limit: 1,
      offset: 1,
    });
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
    expect(p2.total).toBe(3);
  });

  it('devolve a foto do vendedor: a da loja na frente da do Clerk', async () => {
    const { items } = await service.findAll({ limit: 50 });
    const porId = new Map(items.map((i) => [i.id, i as any]));

    // s1 tem foto de loja e foto do Clerk — vence a da loja.
    expect(porId.get('L1').sellerAvatarUrl).toBe('https://r2/loja.png');
    expect(porId.get('L1').sellerName).toBe('Escala Miniaturas');
    // s2 não tem perfil de loja nem foto: o front cai nas iniciais.
    expect(porId.get('L2').sellerAvatarUrl).toBeNull();
    expect(porId.get('L2').sellerName).toBe('Culture TCG');
  });
});
