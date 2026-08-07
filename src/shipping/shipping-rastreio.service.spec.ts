/**
 * ShippingService.rastrearPedido contra SQLite real, com o Melhor Envio mockado.
 *
 * O que só aqui se prova: que os marcos são persistidos, que o evento de entrega
 * sai UMA vez só (na transição), e que um envio ainda a caminho não dispara nada
 * financeiro. A interpretação da resposta já tem teste próprio em rastreio.spec.
 */
import { of } from 'rxjs';
import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import { ShippingService } from './shipping.service';

function createTableSql(tabela: SQLiteTable): string {
  const cfg = getTableConfig(tabela);
  const colunas = cfg.columns.map(
    (c) => `"${c.name}" ${c.getSQLType()}${c.primary ? ' primary key' : ''}`,
  );
  return `create table "${cfg.name}" (${colunas.join(', ')})`;
}

const CART = 'a26a3502-0d21-4817-9b26-c66043dc19bb';

const tracking = (over: Record<string, unknown> = {}) => ({
  [CART]: {
    status: 'posted',
    tracking: 'AP299649960BR',
    generated_at: '2026-08-03 15:19:57',
    posted_at: '2026-08-04 14:18:16',
    delivered_at: null,
    canceled_at: null,
    ...over,
  },
});

describe('ShippingService.rastrearPedido', () => {
  let client: Client;
  let db: ReturnType<typeof drizzle>;
  let service: ShippingService;
  let post: jest.Mock;
  let emit: jest.Mock;

  const criarPedido = (over: Record<string, unknown> = {}) =>
    client.execute({
      sql: `insert into orders (id, buyer_id, seller_id, listing_id, total_in_cents, status,
              shipping_cart_id, tracking_code, shipping_delivered_at)
            values ('o1','b1','s1','l1',10000,?,?,?,?)`,
      args: [
        (over.status as string) ?? 'shipped',
        (over.shipping_cart_id as string) ?? CART,
        (over.tracking_code as string) ?? null,
        (over.shipping_delivered_at as number) ?? null,
      ],
    });

  const ler = async () => {
    const [o] = await db
      .select({
        status: schema.orders.status,
        trackingStatus: schema.orders.trackingStatus,
        deliveredAt: schema.orders.shippingDeliveredAt,
        checkedAt: schema.orders.trackingCheckedAt,
        code: schema.orders.trackingCode,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, 'o1'));
    return o;
  };

  beforeAll(async () => {
    client = createClient({ url: ':memory:' });
    db = drizzle(client, { schema });
    await client.execute(createTableSql(schema.orders as SQLiteTable));
    post = jest.fn();
    emit = jest.fn();
    service = new ShippingService(
      { post } as any,
      db as any,
      { emit } as any,
    );
    (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  afterAll(() => client?.close());
  beforeEach(async () => {
    await client.execute('delete from orders');
    post.mockReset();
    emit.mockReset();
  });

  it('persiste os marcos e o horário da consulta', async () => {
    await criarPedido();
    post.mockReturnValue(of({ data: tracking() }));

    const r = await service.rastrearPedido('o1');

    expect(r?.etapaAtual).toBe('postado');
    const o = await ler();
    expect(o.trackingStatus).toBe('posted');
    expect(o.code).toBe('AP299649960BR');
    expect(o.checkedAt).toBeInstanceOf(Date);
    // Ainda a caminho: nada financeiro.
    expect(o.deliveredAt).toBeNull();
    expect(o.status).toBe('shipped');
    expect(emit).not.toHaveBeenCalled();
  });

  it('entrega nova: grava a entrega e emite o evento UMA vez', async () => {
    await criarPedido();
    post.mockReturnValue(of({ data: tracking({ status: 'delivered', delivered_at: '2026-08-07 11:02:00' }) }));

    await service.rastrearPedido('o1');

    const o = await ler();
    expect(o.deliveredAt).toBeInstanceOf(Date);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('order.rastreio.entregue', expect.objectContaining({ orderId: 'o1' }));

    // Segunda consulta com a mesma entrega: NÃO emite de novo (já constava).
    emit.mockReset();
    await service.rastrearPedido('o1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('pedido sem envio no ME devolve null e não chama o Bling/ME', async () => {
    await criarPedido({ shipping_cart_id: null } as any);
    // Recria sem cart: o insert acima não aceita null facilmente, então zera.
    await client.execute(`update orders set shipping_cart_id = null where id = 'o1'`);

    const r = await service.rastrearPedido('o1');
    expect(r).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('pedido inexistente estoura (não silencia)', async () => {
    await expect(service.rastrearPedido('nao-existe')).rejects.toThrow(/não encontrado/i);
  });
});
