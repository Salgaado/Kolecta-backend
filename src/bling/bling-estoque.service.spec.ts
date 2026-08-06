/**
 * Sincronização de estoque com o Bling, contra um SQLite de verdade.
 *
 * As regras de decisão já têm teste próprio em `estoque-sync.spec.ts`. O que
 * SÓ aqui se prova é o laço que grava: que anúncio sem mudança não é reescrito,
 * que o `status` acompanha o saldo, e que o lote respeita o teto da URL. Foi
 * exatamente uma diferença entre "a regra pura passa" e "o caminho real com
 * dado de verdade" que derrubou a primeira importação do Bling com 500.
 *
 * O `fetch` é o único mockado: chamar o Bling de dentro do teste dependeria de
 * uma loja conectada e do humor da API deles.
 */
import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import { BlingEstoqueService } from './bling-estoque.service';

function createTableSql(tabela: SQLiteTable): string {
  const cfg = getTableConfig(tabela);
  const colunas = cfg.columns.map(
    (c) => `"${c.name}" ${c.getSQLType()}${c.primary ? ' primary key' : ''}`,
  );
  return `create table "${cfg.name}" (${colunas.join(', ')})`;
}

describe('BlingEstoqueService: sincronizar', () => {
  let client: Client;
  let db: ReturnType<typeof drizzle>;
  let service: BlingEstoqueService;
  /** Saldo que o Bling "devolve", por id de produto. */
  let saldosDoBling: Record<number, number>;
  /** Ids pedidos em cada chamada, para conferir o loteamento. */
  let chamadas: number[][];

  const agora = Math.floor(Date.now() / 1000);

  const criarAnuncio = (o: {
    id: string;
    bling?: number | null;
    stock?: number | null;
    status?: string;
    type?: string;
    pausedByStock?: 0 | 1;
    updatedAt?: number;
  }) =>
    client.execute(
      `insert into listings
         (id, seller_id, title, condition, type, status, stock, bling_product_id,
          paused_by_stock, created_at, updated_at)
       values ('${o.id}','s1','Anúncio ${o.id}','novo','${o.type ?? 'direct'}',
               '${o.status ?? 'active'}', ${o.stock ?? 'null'},
               ${o.bling ?? 'null'}, ${o.pausedByStock ?? 0},
               ${agora}, ${o.updatedAt ?? agora})`,
    );

  const ler = async (id: string) => {
    const [l] = await db
      .select({
        stock: schema.listings.stock,
        status: schema.listings.status,
        pausedByStock: schema.listings.pausedByStock,
        updatedAt: schema.listings.updatedAt,
      })
      .from(schema.listings)
      .where(eq(schema.listings.id, id));
    return l;
  };

  beforeAll(async () => {
    client = createClient({ url: ':memory:' });
    db = drizzle(client, { schema });
    await client.execute(createTableSql(schema.listings as SQLiteTable));

    const bling = { getValidToken: jest.fn().mockResolvedValue('tok') };
    service = new BlingEstoqueService(bling as any, db as any);
    (service as any).logger = { log: jest.fn(), error: jest.fn() };

    global.fetch = jest.fn(async (url: any) => {
      const ids = [...String(url).matchAll(/idsProdutos\[\]=(\d+)/g)].map((m) =>
        Number(m[1]),
      );
      chamadas.push(ids);
      return {
        ok: true,
        json: async () => ({
          data: ids
            .filter((id) => saldosDoBling[id] !== undefined)
            .map((id) => ({
              produto: { id },
              saldoFisicoTotal: saldosDoBling[id],
              saldoVirtualTotal: saldosDoBling[id],
            })),
        }),
      } as any;
    }) as any;
  });

  afterAll(() => client?.close());

  beforeEach(async () => {
    await client.execute('delete from listings');
    saldosDoBling = {};
    chamadas = [];
  });

  it('grava o saldo do ERP no anúncio', async () => {
    await criarAnuncio({ id: 'L1', bling: 100, stock: 3 });
    saldosDoBling = { 100: 7 };

    const r = await service.sincronizar('s1');

    expect(await ler('L1')).toMatchObject({ stock: 7, status: 'active' });
    expect(r).toMatchObject({ anuncios: 1, atualizados: 1, pausados: 0, reativados: 0 });
  });

  it('zerou no ERP: tira do ar e marca que foi o estoque', async () => {
    await criarAnuncio({ id: 'L1', bling: 100, stock: 2 });
    saldosDoBling = { 100: 0 };

    const r = await service.sincronizar('s1');

    expect(await ler('L1')).toMatchObject({
      stock: 0, status: 'paused', pausedByStock: true,
    });
    expect(r.pausados).toBe(1);
  });

  it('repôs no ERP: volta ao ar sozinho o que o estoque tinha pausado', async () => {
    await criarAnuncio({
      id: 'L1', bling: 100, stock: 0, status: 'paused', pausedByStock: 1,
    });
    saldosDoBling = { 100: 5 };

    const r = await service.sincronizar('s1');

    expect(await ler('L1')).toMatchObject({
      stock: 5, status: 'active', pausedByStock: false,
    });
    expect(r.reativados).toBe(1);
  });

  it('NÃO republica o que o lojista pausou na mão', async () => {
    await criarAnuncio({
      id: 'L1', bling: 100, stock: 0, status: 'paused', pausedByStock: 0,
    });
    saldosDoBling = { 100: 5 };

    await service.sincronizar('s1');

    // O saldo entra, mas a vitrine continua sem ele: foi decisão do vendedor.
    expect(await ler('L1')).toMatchObject({ stock: 5, status: 'paused' });
  });

  it('não reescreve anúncio que não mudou', async () => {
    // Sem isso, a rodada de meia em meia hora carimbaria updatedAt no catálogo
    // inteiro, e a vitrine, que ordena por atualização, viraria um sorteio.
    const antigo = agora - 90_000;
    await criarAnuncio({ id: 'L1', bling: 100, stock: 4, updatedAt: antigo });
    saldosDoBling = { 100: 4 };

    const r = await service.sincronizar('s1');

    expect(r.atualizados).toBe(0);
    expect((await ler('L1')).updatedAt).toEqual(new Date(antigo * 1000));
  });

  it('ignora anúncio que não veio do Bling', async () => {
    await criarAnuncio({ id: 'L1', bling: null, stock: 9 });
    saldosDoBling = { 100: 0 };

    const r = await service.sincronizar('s1');

    expect(r.anuncios).toBe(0);
    expect(chamadas).toEqual([]); // nem chega a perguntar ao Bling
    expect(await ler('L1')).toMatchObject({ stock: 9, status: 'active' });
  });

  it('não mexe em leilão nem em anúncio recusado', async () => {
    await criarAnuncio({ id: 'LEI', bling: 100, stock: 1, type: 'auction' });
    await criarAnuncio({ id: 'REC', bling: 101, stock: 1, status: 'rejected' });
    saldosDoBling = { 100: 0, 101: 50 };

    const r = await service.sincronizar('s1');

    expect(r.atualizados).toBe(0);
    expect(await ler('LEI')).toMatchObject({ stock: 1, status: 'active' });
    expect(await ler('REC')).toMatchObject({ stock: 1, status: 'rejected' });
  });

  it('produto sumido do ERP não zera o anúncio', async () => {
    await criarAnuncio({ id: 'L1', bling: 999, stock: 3 });
    saldosDoBling = {}; // o Bling não devolve nada para esse id

    const r = await service.sincronizar('s1');

    expect(r.consultados).toBe(0);
    expect(await ler('L1')).toMatchObject({ stock: 3, status: 'active' });
  });

  it('quebra em lotes de 100, que é o teto medido da URL', async () => {
    for (let i = 0; i < 250; i++) {
      await criarAnuncio({ id: `L${i}`, bling: 1000 + i, stock: 1 });
    }
    const r = await service.sincronizar('s1');

    expect(chamadas.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(r.anuncios).toBe(250);
  });

  it('lojista sem nada importado não chama o Bling', async () => {
    const r = await service.sincronizar('s1');
    expect(r).toMatchObject({ anuncios: 0, atualizados: 0 });
    expect(chamadas).toEqual([]);
  });
});
