/**
 * Renovação de token do Bling, contra um SQLite de verdade.
 *
 * O que estes testes prendem é a decisão que doeu: quando desconectar o
 * lojista. Desconectar apaga a conexão OAuth e obriga a reconectar na mão. Num
 * teste real isso derrubou a conexão de um cliente por causa de um refresh token
 * rotacionado, e é exatamente esse caso (falso `invalid_grant` por corrida) que
 * o código passou a tratar, junto com o "não derruba por soluço do Bling".
 *
 * Só o `fetch` é mockado: falar com o OAuth do Bling de dentro do teste
 * dependeria de uma conta conectada e do humor da API deles.
 */
import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import { BlingService } from './bling.service';

function createTableSql(tabela: SQLiteTable): string {
  const cfg = getTableConfig(tabela);
  const colunas = cfg.columns.map(
    (c) => `"${c.name}" ${c.getSQLType()}${c.primary ? ' primary key' : ''}`,
  );
  return `create table "${cfg.name}" (${colunas.join(', ')})`;
}

/** Resposta de fetch fabricada. */
function resp(status: number, body: unknown): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('BlingService.getValidToken (renovação)', () => {
  let client: Client;
  let db: ReturnType<typeof drizzle>;
  let service: BlingService;

  const VENCIDO = Math.floor(Date.now() / 1000) - 10; // já expirado
  const VALIDO = Math.floor(Date.now() / 1000) + 3600;

  const criarConexao = (o: {
    userId?: string;
    access?: string;
    refresh?: string;
    expiresAt?: number;
  }) =>
    client.execute(
      `insert into bling_connections (id, user_id, access_token, refresh_token, expires_at, created_at, updated_at)
       values ('c-${o.userId ?? 's1'}','${o.userId ?? 's1'}','${o.access ?? 'ACCESS_VELHO'}',
               '${o.refresh ?? 'REFRESH_A'}', ${o.expiresAt ?? VENCIDO}, ${VENCIDO}, ${VENCIDO})`,
    );

  const existe = async (userId = 's1') => {
    const rows = await db
      .select()
      .from(schema.blingConnections)
      .where(eq(schema.blingConnections.userId, userId));
    return rows.length > 0 ? rows[0] : null;
  };

  beforeAll(async () => {
    process.env.BLING_CLIENT_ID = 'cid';
    process.env.BLING_CLIENT_SECRET = 'csecret';
    client = createClient({ url: ':memory:' });
    db = drizzle(client, { schema });
    await client.execute(createTableSql(schema.blingConnections as SQLiteTable));
    service = new BlingService(db as any);
    (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  afterAll(() => client?.close());
  beforeEach(async () => {
    await client.execute('delete from bling_connections');
    jest.restoreAllMocks();
  });

  it('token ainda válido: nem chama o Bling', async () => {
    await criarConexao({ expiresAt: VALIDO, access: 'ACCESS_BOM' });
    const spy = jest.spyOn(global, 'fetch' as any);
    expect(await service.getValidToken('s1')).toBe('ACCESS_BOM');
    expect(spy).not.toHaveBeenCalled();
  });

  it('vencido: renova, guarda o novo par e devolve o access novo', async () => {
    await criarConexao({ refresh: 'REFRESH_A' });
    jest.spyOn(global, 'fetch' as any).mockResolvedValue(
      resp(200, { access_token: 'ACCESS_NOVO', refresh_token: 'REFRESH_B', expires_in: 21600 }),
    );

    expect(await service.getValidToken('s1')).toBe('ACCESS_NOVO');

    const conn = await existe();
    // O refresh rotaciona: o novo tem que ser persistido, senão a próxima
    // renovação usaria o velho (já consumido) e cairia em invalid_grant.
    expect(conn?.refreshToken).toBe('REFRESH_B');
    expect(conn?.accessToken).toBe('ACCESS_NOVO');
  });

  it('invalid_grant: desconecta, porque só reconectar resolve', async () => {
    await criarConexao({});
    jest.spyOn(global, 'fetch' as any).mockResolvedValue(
      resp(400, { error: 'invalid_grant', error_description: 'refresh token is invalid' }),
    );

    await expect(service.getValidToken('s1')).rejects.toThrow(/expirou|Reconecte/i);
    expect(await existe()).toBeNull();
  });

  it('Bling fora do ar (500): MANTÉM a conexão', async () => {
    // Foi o cerne do incidente: um soluço do Bling não pode custar a conexão do
    // lojista, que ele teria de reconectar na mão sem ter feito nada.
    await criarConexao({});
    jest.spyOn(global, 'fetch' as any).mockResolvedValue(resp(500, { error: 'server_error' }));

    await expect(service.getValidToken('s1')).rejects.toThrow(/Bling não respondeu|instantes/i);
    expect(await existe()).not.toBeNull();
  });

  it('rate limit (429): MANTÉM a conexão', async () => {
    await criarConexao({});
    jest.spyOn(global, 'fetch' as any).mockResolvedValue(resp(429, { error: 'too_many_requests' }));

    await expect(service.getValidToken('s1')).rejects.toThrow();
    expect(await existe()).not.toBeNull();
  });

  it('falha de rede (fetch lança): MANTÉM a conexão', async () => {
    await criarConexao({});
    jest.spyOn(global, 'fetch' as any).mockRejectedValue(new Error('ECONNRESET'));

    await expect(service.getValidToken('s1')).rejects.toThrow(/Bling|instantes/i);
    expect(await existe()).not.toBeNull();
  });

  it('invalid_client (400): NÃO desconecta, é config do servidor', async () => {
    // O lojista reconectar não conserta credencial errada do app. Derrubá-lo só
    // esconderia o problema real, que é da Kolecta.
    await criarConexao({});
    jest.spyOn(global, 'fetch' as any).mockResolvedValue(
      resp(400, { error: 'invalid_client' }),
    );

    await expect(service.getValidToken('s1')).rejects.toThrow();
    expect(await existe()).not.toBeNull();
  });

  it('corrida: invalid_grant no token velho, mas o banco já tem outro renovado', async () => {
    // Cenário do incidente: entre a leitura e o refresh, OUTRO processo (o cron)
    // renovou. Nosso token ficou velho e o Bling responde invalid_grant. Isso é
    // falso alarme: a conexão está viva com um token novo, e desconectar
    // derrubaria uma conta saudável.
    await criarConexao({ refresh: 'REFRESH_A', access: 'ACCESS_VELHO' });

    jest.spyOn(global, 'fetch' as any).mockImplementation(async (_url: any, init: any) => {
      const usado = new URLSearchParams(init.body).get('refresh_token');
      if (usado === 'REFRESH_A') {
        // No meio da chamada, o "outro processo" já gravou o par novo e válido.
        await client.execute(
          `update bling_connections set refresh_token='REFRESH_B', access_token='ACCESS_DO_CRON',
             expires_at=${VALIDO} where user_id='s1'`,
        );
        return resp(400, { error: 'invalid_grant' });
      }
      throw new Error('não deveria tentar renovar de novo: o token do banco está válido');
    });

    // Devolve o access que o outro processo deixou, sem desconectar.
    expect(await service.getValidToken('s1')).toBe('ACCESS_DO_CRON');
    expect(await existe()).not.toBeNull();
  });
});
