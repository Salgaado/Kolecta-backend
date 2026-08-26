/**
 * Renovação de token do Tiny, contra um SQLite de verdade.
 *
 * O que estes testes prendem é a decisão que doeu no Bling: quando desconectar
 * o lojista. Desconectar apaga a conexão OAuth e obriga a reconectar na mão —
 * num teste real isso derrubou a conexão de um cliente por causa de um refresh
 * token rotacionado, e é esse caso (falso `invalid_grant` por corrida) que o
 * código trata, junto com o "não derruba por soluço do ERP".
 *
 * Tem um caso a mais que o Bling não precisa: o Keycloak só manda
 * `refresh_token` novo quando a rotação está ligada, e sobrescrever com
 * `undefined` apagaria o token bom.
 *
 * Só o `fetch` é mockado: falar com o OAuth deles de dentro do teste dependeria
 * de uma conta conectada e do humor da API.
 */
import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import { TinyService } from './tiny.service';

function createTableSql(tabela: SQLiteTable): string {
  const cfg = getTableConfig(tabela);
  const colunas = cfg.columns.map(
    (c) => `"${c.name}" ${c.getSQLType()}${c.primary ? ' primary key' : ''}`,
  );
  return `create table "${cfg.name}" (${colunas.join(', ')})`;
}

function resp(status: number, body: unknown): any {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('TinyService.getValidToken (renovação)', () => {
  let client: Client;
  let db: ReturnType<typeof drizzle>;
  let service: TinyService;

  const VENCIDO = Math.floor(Date.now() / 1000) - 10;
  const VALIDO = Math.floor(Date.now() / 1000) + 3600;

  const criarConexao = (o: {
    userId?: string;
    access?: string;
    refresh?: string;
    expiresAt?: number;
  }) =>
    client.execute(
      `insert into tiny_connections (id, user_id, access_token, refresh_token, expires_at, created_at, updated_at)
       values ('c-${o.userId ?? 's1'}','${o.userId ?? 's1'}','${o.access ?? 'ACCESS_VELHO'}',
               '${o.refresh ?? 'REFRESH_A'}', ${o.expiresAt ?? VENCIDO}, ${VENCIDO}, ${VENCIDO})`,
    );

  const conexao = async (userId = 's1') => {
    const rows = await db
      .select()
      .from(schema.tinyConnections)
      .where(eq(schema.tinyConnections.userId, userId));
    return rows.length > 0 ? rows[0] : null;
  };

  beforeAll(async () => {
    process.env.TINY_CLIENT_ID = 'cid';
    process.env.TINY_CLIENT_SECRET = 'csecret';
    client = createClient({ url: ':memory:' });
    db = drizzle(client, { schema });
    await client.execute(createTableSql(schema.tinyConnections as SQLiteTable));
    service = new TinyService(db as any);
    (service as any).logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  afterAll(() => client?.close());
  beforeEach(async () => {
    await client.execute('delete from tiny_connections');
    jest.restoreAllMocks();
  });

  it('sem conexão, avisa em vez de tentar renovar o nada', async () => {
    await expect(service.getValidToken('s1')).rejects.toThrow(/não conectado/i);
  });

  it('token ainda válido: nem chama o Tiny', async () => {
    await criarConexao({ expiresAt: VALIDO, access: 'ACCESS_BOM' });
    const spy = jest.spyOn(global, 'fetch' as any);
    expect(await service.getValidToken('s1')).toBe('ACCESS_BOM');
    expect(spy).not.toHaveBeenCalled();
  });

  it('vencido: renova, guarda o novo par e devolve o access novo', async () => {
    await criarConexao({ refresh: 'REFRESH_A' });
    jest.spyOn(global, 'fetch' as any).mockResolvedValue(
      resp(200, {
        access_token: 'ACCESS_NOVO',
        refresh_token: 'REFRESH_B',
        expires_in: 3600,
      }),
    );

    expect(await service.getValidToken('s1')).toBe('ACCESS_NOVO');
    const conn = await conexao();
    expect(conn!.accessToken).toBe('ACCESS_NOVO');
    expect(conn!.refreshToken).toBe('REFRESH_B');
    expect(conn!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('renovação SEM refresh novo mantém o antigo, e não apaga a conexão', async () => {
    // O Keycloak só rotaciona o refresh token quando está configurado para
    // isso. Gravar `undefined` aqui deixaria a conexão viva mas impossível de
    // renovar na próxima vez — quebra silenciosa, meia hora depois.
    await criarConexao({ refresh: 'REFRESH_A' });
    jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue(
        resp(200, { access_token: 'ACCESS_NOVO', expires_in: 3600 }),
      );

    await service.getValidToken('s1');
    expect((await conexao())!.refreshToken).toBe('REFRESH_A');
  });

  it('refresh token revogado (400 invalid_grant): desconecta e manda reconectar', async () => {
    await criarConexao({});
    jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue(resp(400, { error: 'invalid_grant' }));

    await expect(service.getValidToken('s1')).rejects.toThrow(/Reconecte/i);
    expect(await conexao()).toBeNull();
  });

  it('erro do lado deles (500) NÃO desconecta ninguém', async () => {
    // Obrigar o lojista a reconectar por um soluço do ERP que já passou é bug
    // nosso, não dele.
    await criarConexao({});
    jest.spyOn(global, 'fetch' as any).mockResolvedValue(resp(500, {}));

    await expect(service.getValidToken('s1')).rejects.toThrow(/não respondeu/i);
    expect(await conexao()).not.toBeNull();
  });

  it('limite de requisição (429) NÃO desconecta ninguém', async () => {
    await criarConexao({});
    jest.spyOn(global, 'fetch' as any).mockResolvedValue(resp(429, {}));

    await expect(service.getValidToken('s1')).rejects.toThrow(/não respondeu/i);
    expect(await conexao()).not.toBeNull();
  });

  it('falha de rede NÃO desconecta ninguém', async () => {
    await criarConexao({});
    jest
      .spyOn(global, 'fetch' as any)
      .mockRejectedValue(new Error('ECONNRESET'));

    await expect(service.getValidToken('s1')).rejects.toThrow(
      /não foi possível/i,
    );
    expect(await conexao()).not.toBeNull();
  });

  it('corrida: outro processo já renovou, então o invalid_grant é falso alarme', async () => {
    // O cron de estoque e uma requisição do lojista podem renovar ao mesmo
    // tempo. Quem chega depois usa um refresh já gasto e leva `invalid_grant` —
    // desconectar aí derrubaria uma conexão perfeitamente saudável.
    await criarConexao({ refresh: 'REFRESH_A' });
    jest.spyOn(global, 'fetch' as any).mockImplementation(async () => {
      // Simula o outro processo terminando a renovação no meio do caminho.
      await client.execute(
        `update tiny_connections
            set refresh_token='REFRESH_B', access_token='ACCESS_DO_OUTRO', expires_at=${VALIDO}
          where user_id='s1'`,
      );
      return resp(400, { error: 'invalid_grant' });
    });

    expect(await service.getValidToken('s1')).toBe('ACCESS_DO_OUTRO');
    expect(await conexao()).not.toBeNull();
  });

  it('renova com as credenciais no corpo e o refresh certo', async () => {
    await criarConexao({ refresh: 'REFRESH_A' });
    const spy = jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue(
        resp(200, { access_token: 'A', refresh_token: 'B', expires_in: 60 }),
      );

    await service.getValidToken('s1');

    const [url, init] = spy.mock.calls[0] as any[];
    expect(url).toContain('accounts.tiny.com.br');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('REFRESH_A');
    expect(body.get('client_secret')).toBe('csecret');
  });

  it('renova ANTES de vencer, com margem de 60s', async () => {
    // Sem margem, um token que vence entre a checagem e a chamada volta 401 e a
    // rodada de estoque perde o lojista inteiro por um segundo de diferença.
    await criarConexao({ expiresAt: Math.floor(Date.now() / 1000) + 30 });
    jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue(
        resp(200, { access_token: 'ACCESS_NOVO', expires_in: 3600 }),
      );

    expect(await service.getValidToken('s1')).toBe('ACCESS_NOVO');
  });

  it('uma conexão com problema não contamina a do vizinho', async () => {
    await criarConexao({
      userId: 's1',
      expiresAt: VALIDO,
      access: 'ACCESS_S1',
    });
    await criarConexao({ userId: 's2' });
    jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue(resp(400, { error: 'invalid_grant' }));

    await expect(service.getValidToken('s2')).rejects.toThrow(/Reconecte/i);
    expect(await conexao('s2')).toBeNull();
    expect((await conexao('s1'))!.accessToken).toBe('ACCESS_S1');
  });
});
