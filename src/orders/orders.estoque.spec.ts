/**
 * Baixa de estoque na confirmação do pagamento.
 *
 * Contra um SQLite de verdade porque o ponto do teste é justamente o que um
 * mock não prova: que a subtração acontece DENTRO do banco
 * (`stock = stock - 1 WHERE stock > 0`) e não numa leitura seguida de escrita
 * pelo Node — que é o que deixaria duas pessoas comprando a última unidade ao
 * mesmo tempo levarem o estoque a negativo.
 */

import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import { OrdersService } from './orders.service';

function createTableSql(tabela: SQLiteTable): string {
  const cfg = getTableConfig(tabela);
  const colunas = cfg.columns.map(
    (c) => `"${c.name}" ${c.getSQLType()}${c.primary ? ' primary key' : ''}`,
  );
  return `create table "${cfg.name}" (${colunas.join(', ')})`;
}

describe('OrdersService — baixa de estoque', () => {
  let client: Client;
  let db: ReturnType<typeof drizzle>;
  let baixar: (listingId: string) => Promise<void>;

  const agora = Math.floor(Date.now() / 1000);

  const criarAnuncio = (id: string, stock: number | null) =>
    client.execute(
      `insert into listings (id, seller_id, title, condition, type, status, stock, created_at, updated_at)
       values ('${id}','s1','Anúncio ${id}','novo','direct','active',${stock ?? 'null'},${agora},${agora})`,
    );

  const ler = async (id: string) => {
    const [l] = await db
      .select({ stock: schema.listings.stock, status: schema.listings.status })
      .from(schema.listings)
      .where(eq(schema.listings.id, id));
    return l;
  };

  beforeAll(async () => {
    client = createClient({ url: ':memory:' });
    db = drizzle(client, { schema });
    await client.execute(createTableSql(schema.listings as SQLiteTable));

    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).logger = { log: jest.fn(), warn: jest.fn() };
    // `baixarEstoque` recebe a transação; aqui o próprio db faz esse papel.
    baixar = (listingId: string) =>
      (service as any).baixarEstoque(db, listingId);
  });

  afterAll(() => client?.close());
  beforeEach(() => client.execute('delete from listings'));

  it('desconta uma unidade e mantém o anúncio no ar', async () => {
    await criarAnuncio('L1', 3);
    await baixar('L1');
    expect(await ler('L1')).toEqual({ stock: 2, status: 'active' });
  });

  it('ao zerar, pausa em vez de marcar vendido', async () => {
    // Pausado o vendedor repõe e reativa direto; `sold` obrigaria a recriar.
    await criarAnuncio('L1', 1);
    await baixar('L1');
    expect(await ler('L1')).toEqual({ stock: 0, status: 'paused' });
  });

  it('sem estoque informado, segue a regra antiga: unidade única, vendido', async () => {
    await criarAnuncio('L1', null);
    await baixar('L1');
    expect(await ler('L1')).toEqual({ stock: null, status: 'sold' });
  });

  it('nunca deixa o estoque negativo, mesmo com duas compras simultâneas', async () => {
    await criarAnuncio('L1', 1);
    await Promise.all([baixar('L1'), baixar('L1')]);

    const { stock, status } = await ler('L1');
    expect(stock).toBe(0);
    // A segunda não achou unidade para baixar e caiu na regra de unidade única.
    expect(['paused', 'sold']).toContain(status);
  });

  it('anúncio já zerado não fica com estoque negativo', async () => {
    await criarAnuncio('L1', 0);
    await baixar('L1');
    expect((await ler('L1')).stock).toBe(0);
  });
});
