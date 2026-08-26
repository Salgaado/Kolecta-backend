/**
 * A ida e a volta do OAuth do Tiny, sem subir o Nest e sem rede.
 *
 * Duas coisas são prendidas aqui, e as duas são cicatriz do Bling:
 *
 * 1. O ENDEREÇO. No Bling, mandar dado para o host do OAuth devolvia 403 em
 *    tudo e a integração ficou "conectada" e inútil em duas lojas. No Tiny são
 *    três hosts, então errar é ainda mais fácil.
 * 2. O `state`. O callback é público: se ele não for assinado, qualquer um
 *    amarra o ERP dele à conta de outro vendedor e passa a receber os pedidos
 *    daquele vendedor, com nome e e-mail dos compradores junto.
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

describe('TinyService — OAuth', () => {
  let client: Client;
  let db: ReturnType<typeof drizzle>;
  let service: TinyService;
  const NODE_ENV_ORIGINAL = process.env.NODE_ENV;

  beforeAll(async () => {
    process.env.TINY_CLIENT_ID = 'cid';
    process.env.TINY_CLIENT_SECRET = 'csecret';
    process.env.TINY_REDIRECT_URI =
      'https://kolecta-backend.onrender.com/api/tiny/callback';
    client = createClient({ url: ':memory:' });
    db = drizzle(client, { schema });
    await client.execute(createTableSql(schema.tinyConnections as SQLiteTable));
    // O `createTableSql` acima só copia colunas, e o UNIQUE de `user_id` é o
    // que faz o `onConflictDoUpdate` do reconectar funcionar. Sem ele o teste
    // passaria longe do que a produção faz — lá o UNIQUE está no DDL do
    // scripts/add-tiny-connection.ts.
    await client.execute(
      'create unique index uq_tiny_connections_user on tiny_connections (user_id)',
    );
    service = new TinyService(db as any);
    (service as any).logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  afterAll(() => client?.close());
  beforeEach(async () => {
    process.env.NODE_ENV = NODE_ENV_ORIGINAL;
    await client.execute('delete from tiny_connections');
    jest.restoreAllMocks();
  });

  describe('getAuthUrl', () => {
    it('aponta para o Keycloak deles, e não para a API nem para o Swagger', () => {
      const url = new URL(service.getAuthUrl('s1'));
      expect(url.origin).toBe('https://accounts.tiny.com.br');
      expect(url.pathname).toBe('/realms/tiny/protocol/openid-connect/auth');
      // erp.tiny.com.br é DOCUMENTAÇÃO e api.tiny.com.br é dado. Nenhum dos
      // dois autoriza nada.
      expect(url.host).not.toBe('erp.tiny.com.br');
      expect(url.host).not.toBe('api.tiny.com.br');
    });

    it('pede offline_access, senão o token morre com a sessão do lojista', () => {
      // Sem token offline, o Keycloak amarra o refresh à sessão do usuário (30
      // minutos ociosos no padrão dele) e a sincronização de estoque pararia
      // toda vez que o lojista fechasse o navegador.
      const scope = new URL(service.getAuthUrl('s1')).searchParams.get('scope');
      expect(scope).toContain('offline_access');
      expect(scope).toContain('openid');
    });

    it('leva o redirect_uri e o code flow', () => {
      const p = new URL(service.getAuthUrl('s1')).searchParams;
      expect(p.get('response_type')).toBe('code');
      expect(p.get('client_id')).toBe('cid');
      expect(p.get('redirect_uri')).toBe(
        'https://kolecta-backend.onrender.com/api/tiny/callback',
      );
    });

    it('NÃO leva o userId cru no state', () => {
      const state = new URL(service.getAuthUrl('s1')).searchParams.get(
        'state',
      )!;
      expect(state).not.toBe('s1');
      expect(state.split('.')).toHaveLength(3); // userId.timestamp.assinatura
    });

    it('recusa redirect de localhost em produção', () => {
      // O lojista autorizaria e o navegador DELE voltaria para um localhost que
      // não existe: nenhum log, nenhuma linha no banco, e o sintoma "ninguém
      // conectou" é idêntico a "ninguém tentou".
      process.env.NODE_ENV = 'production';
      process.env.TINY_REDIRECT_URI = 'http://localhost:3000/api/tiny/callback';
      expect(() => service.getAuthUrl('s1')).toThrow(/mal configurada/i);
      process.env.TINY_REDIRECT_URI =
        'https://kolecta-backend.onrender.com/api/tiny/callback';
    });

    it('sem configuração no servidor, falha cedo e claro', () => {
      const antes = process.env.TINY_CLIENT_ID;
      delete process.env.TINY_CLIENT_ID;
      expect(() => service.getAuthUrl('s1')).toThrow(/não configurado/i);
      process.env.TINY_CLIENT_ID = antes;
    });
  });

  describe('handleCallback', () => {
    const tokens = {
      access_token: 'ACCESS_NOVO',
      refresh_token: 'REFRESH_NOVO',
      expires_in: 3600,
    };

    it('guarda os tokens no vendedor que abriu a autorização', async () => {
      const state = new URL(service.getAuthUrl('s1')).searchParams.get(
        'state',
      )!;
      jest.spyOn(global, 'fetch' as any).mockResolvedValue(resp(200, tokens));

      await service.handleCallback('CODE', state);

      const [conn] = await db
        .select()
        .from(schema.tinyConnections)
        .where(eq(schema.tinyConnections.userId, 's1'));
      expect(conn.accessToken).toBe('ACCESS_NOVO');
      expect(conn.refreshToken).toBe('REFRESH_NOVO');
      expect(conn.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('manda as credenciais no CORPO, no formato do Keycloak', async () => {
      const state = new URL(service.getAuthUrl('s1')).searchParams.get(
        'state',
      )!;
      const spy = jest
        .spyOn(global, 'fetch' as any)
        .mockResolvedValue(resp(200, tokens));

      await service.handleCallback('CODE', state);

      const [url, init] = spy.mock.calls[0] as any[];
      expect(url).toBe(
        'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token',
      );
      const body = new URLSearchParams(init.body);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('CODE');
      expect(body.get('client_id')).toBe('cid');
      expect(body.get('client_secret')).toBe('csecret');
    });

    it('state adulterado não conecta nada', async () => {
      // Este é o teste que impede o sequestro de conta: trocar o userId dentro
      // do state invalida a assinatura.
      const state = new URL(service.getAuthUrl('s1')).searchParams.get(
        'state',
      )!;
      const [, ts, assinatura] = state.split('.');
      const spy = jest.spyOn(global, 'fetch' as any);

      await expect(
        service.handleCallback('CODE', `VITIMA.${ts}.${assinatura}`),
      ).rejects.toThrow(/inválida/i);
      expect(spy).not.toHaveBeenCalled();
    });

    it('state de formato estranho não conecta nada', async () => {
      await expect(service.handleCallback('CODE', 's1')).rejects.toThrow(
        /inválida/i,
      );
      await expect(service.handleCallback('CODE', '')).rejects.toThrow(
        /inválida/i,
      );
    });

    it('state velho expira: o code do OAuth é curto e de uso único', async () => {
      const antigo = Date.now() - 11 * 60 * 1000;
      const corpo = `s1.${antigo}`;
      const assinatura = (service as any).hmac(corpo);
      await expect(
        service.handleCallback('CODE', `${corpo}.${assinatura}`),
      ).rejects.toThrow(/expirou/i);
    });

    it('reconectar sobrescreve a conexão, sem duplicar linha', async () => {
      jest.spyOn(global, 'fetch' as any).mockResolvedValue(resp(200, tokens));
      const s1 = new URL(service.getAuthUrl('s1')).searchParams.get('state')!;
      await service.handleCallback('CODE', s1);

      jest
        .spyOn(global, 'fetch' as any)
        .mockResolvedValue(resp(200, { ...tokens, access_token: 'ACCESS_2' }));
      const s2 = new URL(service.getAuthUrl('s1')).searchParams.get('state')!;
      await service.handleCallback('CODE', s2);

      const linhas = await db.select().from(schema.tinyConnections);
      expect(linhas).toHaveLength(1);
      expect(linhas[0].accessToken).toBe('ACCESS_2');
    });

    it('token sem expires_in vence em 5 minutos, e não daqui a horas', async () => {
      // Errar para o lado de renovar cedo demais é barato; errar para o outro
      // lado é a integração inteira respondendo 401 sem explicação.
      jest
        .spyOn(global, 'fetch' as any)
        .mockResolvedValue(
          resp(200, { access_token: 'A', refresh_token: 'R' }),
        );
      const state = new URL(service.getAuthUrl('s1')).searchParams.get(
        'state',
      )!;
      await service.handleCallback('CODE', state);

      const [conn] = await db.select().from(schema.tinyConnections);
      const daquiA = conn.expiresAt - Math.floor(Date.now() / 1000);
      expect(daquiA).toBeLessThanOrEqual(300);
      expect(daquiA).toBeGreaterThan(280);
    });
  });
});
