/**
 * OrdersService.aoEntregarPeloRastreio contra SQLite real.
 *
 * É a peça que mexe perto do dinheiro: o rastreio acusou entrega, o pedido
 * avança para 'delivered' e abre a janela de 48h do auto-release. O que estes
 * testes prendem é o conservadorismo: só avança pedido 'shipped', nunca regride
 * um que o comprador já confirmou, e é idempotente (o cron pode reemitir).
 *
 * A liberação de saldo em si NÃO acontece aqui: fica no cron de auto-release,
 * que tem o gate de disputa. Aqui só se prova a transição de status.
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

describe('OrdersService.aoEntregarPeloRastreio', () => {
  let client: Client;
  let db: ReturnType<typeof drizzle>;
  let service: OrdersService;

  const entregueEm = new Date('2026-08-07T14:00:00Z');

  const criarPedido = (status: string) =>
    client.execute({
      sql: `insert into orders (id, buyer_id, seller_id, listing_id, total_in_cents, status)
            values ('o1','b1','s1','l1',10000,?)`,
      args: [status],
    });

  const ler = async () => {
    const [o] = await db
      .select({
        status: schema.orders.status,
        deliveredAt: schema.orders.deliveredAt,
        autoReleaseAt: schema.orders.autoReleaseAt,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, 'o1'));
    return o;
  };

  beforeAll(async () => {
    client = createClient({ url: ':memory:' });
    db = drizzle(client, { schema });
    await client.execute(createTableSql(schema.orders as SQLiteTable));
    service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).db = db;
    (service as any).logger = { log: jest.fn(), error: jest.fn() };
  });

  afterAll(() => client?.close());
  beforeEach(() => client.execute('delete from orders'));

  it("pedido 'shipped' vira 'delivered' com janela de 48h", async () => {
    await criarPedido('shipped');
    await service.aoEntregarPeloRastreio({ orderId: 'o1', entregueEm });

    const o = await ler();
    expect(o.status).toBe('delivered');
    expect(o.deliveredAt).toEqual(entregueEm);
    // 48h depois da entrega.
    expect(o.autoReleaseAt).toEqual(new Date(entregueEm.getTime() + 48 * 3600 * 1000));
  });

  it("NÃO regride um pedido que o comprador já confirmou (completed)", async () => {
    await criarPedido('completed');
    await service.aoEntregarPeloRastreio({ orderId: 'o1', entregueEm });
    expect((await ler()).status).toBe('completed');
  });

  it("NÃO mexe em 'delivered' já existente (idempotente)", async () => {
    await criarPedido('delivered');
    await service.aoEntregarPeloRastreio({ orderId: 'o1', entregueEm });
    // Continua delivered, sem reabrir nova janela por cima.
    expect((await ler()).status).toBe('delivered');
  });

  it('pedido inexistente não quebra', async () => {
    await expect(
      service.aoEntregarPeloRastreio({ orderId: 'sumido', entregueEm }),
    ).resolves.toBeUndefined();
  });
});
