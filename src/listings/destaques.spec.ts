/**
 * Destaques da loja, contra um SQLite de verdade, em memória.
 *
 * Duas coisas aqui só quebram no banco, nunca num mock: o `batch` que limpa e
 * regrava os destaques numa ida só, e o `ORDER BY` cru que põe o destaque em
 * primeiro. Mock de Drizzle aceitaria SQL inválido e ordem errada calados.
 *
 * O outro lado é a REGRA: destaque é do vendedor, é de anúncio ativo, e são no
 * máximo 4. Um furo em qualquer uma delas deixa o vendedor fixar o que não é
 * dele ou fixar item que a loja não mostra.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException } from '@nestjs/common';
import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../database/schema';
import { ListingsService } from './listings.service';
import { SellersService } from '../sellers/sellers.service';
import { MAX_DESTAQUES } from './destaques';
import type { FounderService } from '../founder/founder.service';

function createTableSql(tabela: SQLiteTable): string {
  const cfg = getTableConfig(tabela);
  const colunas = cfg.columns.map((c) => {
    const tipo = c.getSQLType();
    return `"${c.name}" ${tipo}${c.primary ? ' primary key' : ''}`;
  });
  return `create table "${cfg.name}" (${colunas.join(', ')})`;
}

describe('Destaques da loja', () => {
  let client: Client;
  let listingsService: ListingsService;
  let sellersService: SellersService;

  const agora = Math.floor(Date.now() / 1000);

  beforeEach(async () => {
    client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });

    for (const t of [
      schema.users,
      schema.sellerProfiles,
      schema.categories,
      schema.listings,
      schema.auctions,
      schema.bids,
      schema.orders,
      schema.reviews,
    ]) {
      await client.execute(createTableSql(t as SQLiteTable));
    }

    listingsService = new ListingsService(
      db as any,
      {} as FounderService,
      new EventEmitter2(),
    );
    sellersService = new SellersService(db as any);

    await client.batch([
      `insert into users (id, email, name, role, created_at, updated_at)
       values ('s1','a@a','Daniel','user',${agora},${agora})`,
      `insert into users (id, email, name, role, created_at, updated_at)
       values ('s2','b@b','Outro','user',${agora},${agora})`,
    ]);

    const anuncio = (
      id: string,
      dados: Record<string, string | number | null> = {},
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
      anuncio('L1'),
      anuncio('L2'),
      anuncio('L3'),
      anuncio('L4'),
      anuncio('L5'),
      anuncio('L6', { status: 'paused' }),
      anuncio('X1', { seller_id: 's2' }),
    ]);
  });

  afterEach(() => client?.close());

  /** Quais anúncios estão destacados (conjunto, não ordem — ver `vitrine`). */
  const destacados = async () => {
    const { rows } = await client.execute(
      `select id from listings where store_pinned_at is not null order by id asc`,
    );
    return rows.map((r) => r.id as string);
  };

  const vitrine = async () => {
    const { data } = await sellersService.getSellerListings('s1', 1, 50);
    return data.map((l: { id: string }) => l.id);
  };

  // ─── Regras ────────────────────────────────────────────────────────────────

  it('fixa os anúncios escolhidos', async () => {
    await listingsService.destacar('s1', ['L2', 'L4']);
    expect(await destacados()).toEqual(['L2', 'L4']);
  });

  it('recusa mais que o máximo', async () => {
    await expect(
      listingsService.destacar('s1', ['L1', 'L2', 'L3', 'L4', 'L5']),
    ).rejects.toThrow(BadRequestException);
    expect(await destacados()).toEqual([]);
  });

  it('aceita exatamente o máximo', async () => {
    const ids = ['L1', 'L2', 'L3', 'L4'].slice(0, MAX_DESTAQUES);
    await listingsService.destacar('s1', ids);
    expect((await destacados()).length).toBe(MAX_DESTAQUES);
  });

  it('recusa id repetido', async () => {
    await expect(
      listingsService.destacar('s1', ['L1', 'L1']),
    ).rejects.toThrow(BadRequestException);
  });

  it('recusa anúncio de outro vendedor — e não fixa nada do lote', async () => {
    await expect(
      listingsService.destacar('s1', ['L1', 'X1']),
    ).rejects.toThrow(BadRequestException);
    // Nem o L1, que era legítimo: o vendedor precisa ver o erro e reenviar, e
    // não descobrir depois que metade do que ele escolheu ficou de fora.
    expect(await destacados()).toEqual([]);
  });

  it('recusa anúncio que não está ativo', async () => {
    await expect(
      listingsService.destacar('s1', ['L6']),
    ).rejects.toThrow(BadRequestException);
  });

  it('recusa anúncio inexistente', async () => {
    await expect(
      listingsService.destacar('s1', ['nao-existe']),
    ).rejects.toThrow(BadRequestException);
  });

  it('lista vazia limpa os destaques', async () => {
    await listingsService.destacar('s1', ['L1', 'L2']);
    await listingsService.destacar('s1', []);
    expect(await destacados()).toEqual([]);
  });

  it('não mexe no destaque de outro vendedor', async () => {
    await client.execute(
      `update listings set store_pinned_at = ${agora} where id = 'X1'`,
    );
    await listingsService.destacar('s1', ['L1']);
    const { rows } = await client.execute(
      `select store_pinned_at from listings where id = 'X1'`,
    );
    expect(rows[0].store_pinned_at).not.toBeNull();
  });

  // ─── "Desde quando" ────────────────────────────────────────────────────────

  it('quem já estava destacado mantém o instante em que foi fixado', async () => {
    await client.execute(
      `update listings set store_pinned_at = ${agora - 5000} where id = 'L3'`,
    );

    // Um segundo salvamento, com o L3 ainda na lista. O instante dele não pode
    // ser regravado: é o que responde "destacado desde quando".
    await listingsService.destacar('s1', ['L1', 'L3', 'L2']);

    const { rows } = await client.execute(
      `select store_pinned_at from listings where id = 'L3'`,
    );
    expect(rows[0].store_pinned_at).toBe(agora - 5000);
  });

  it('desfixar e refixar recomeça a contagem', async () => {
    await client.execute(
      `update listings set store_pinned_at = ${agora - 5000} where id = 'L3'`,
    );
    await listingsService.destacar('s1', []);
    await listingsService.destacar('s1', ['L3']);

    const { rows } = await client.execute(
      `select store_pinned_at from listings where id = 'L3'`,
    );
    expect(Number(rows[0].store_pinned_at)).toBeGreaterThan(agora - 5000);
  });

  // ─── Vitrine ───────────────────────────────────────────────────────────────

  it('destaque vem primeiro na vitrine da loja, na frente da ordem manual', async () => {
    // O vendedor arrastou L5 para o topo…
    await listingsService.reorder('s1', ['L5', 'L1', 'L2', 'L3', 'L4']);
    // …mas destacou o L3.
    await listingsService.destacar('s1', ['L3']);

    const ordem = await vitrine();
    expect(ordem[0]).toBe('L3');
    expect(ordem[1]).toBe('L5');
  });

  // Quatro destaques salvos de uma vez recebem o MESMO segundo em
  // `store_pinned_at`. Se a ordem dependesse do instante, a faixa sairia numa
  // ordem qualquer — e diferente a cada consulta. Quem manda é `position`.
  it('entre destaques, vale a ordem que o vendedor arrastou', async () => {
    await listingsService.reorder('s1', ['L5', 'L4', 'L3', 'L2', 'L1']);
    await listingsService.destacar('s1', ['L1', 'L2', 'L3', 'L4']);

    const ordem = await vitrine();
    expect(ordem.slice(0, 4)).toEqual(['L4', 'L3', 'L2', 'L1']);
    // O não-destacado que estava em primeiro na ordem manual cai para trás dos
    // quatro, sem perder a posição relativa dele.
    expect(ordem[4]).toBe('L5');
  });

  it('destaque vem primeiro mesmo com paginação', async () => {
    // Fixa o mais recente-menos-provável de cair na primeira página e força
    // páginas de 2. O "sempre em primeiro" tem que valer na CONSULTA, não só na
    // tela: quem consome a rota direto recebe a página 1 com o destaque.
    await listingsService.reorder('s1', ['L1', 'L2', 'L3', 'L4', 'L5']);
    await listingsService.destacar('s1', ['L5']);

    const { data } = await sellersService.getSellerListings('s1', 1, 2);
    expect(data.map((l: { id: string }) => l.id)[0]).toBe('L5');
  });

  it('anúncio pausado depois de destacado some da vitrine', async () => {
    await listingsService.destacar('s1', ['L1']);
    await client.execute(`update listings set status='paused' where id='L1'`);
    expect(await vitrine()).not.toContain('L1');
  });
});
