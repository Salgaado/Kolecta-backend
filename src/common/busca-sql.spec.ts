/**
 * Roda contra um SQLite de verdade, em memória, de propósito.
 *
 * O que quebra aqui não é lógica de JavaScript: é o SQL gerado. A primeira
 * versão desta busca montava uma cadeia única de ~50 `replace` aninhados e o
 * banco respondia "parser stack overflow" — erro que nenhum mock de Drizzle
 * pegaria, e que só apareceria como 500 na vitrine em produção.
 */

import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../database/schema';
import { alvoDeBusca, condicaoDeBusca, palavrasDoTermo } from './busca-sql';

describe('busca-sql', () => {
  let client: Client;
  let db: ReturnType<typeof drizzle>;

  // Nome do vendedor entra na busca como no serviço: quem procura pela loja
  // espera achar o que ela vende.
  const nomeDoVendedor = sql<string | null>`COALESCE(
    NULLIF(TRIM(${schema.sellerProfiles.storeName}), ''),
    NULLIF(TRIM(${schema.users.name}), '')
  )`;

  const alvo = () =>
    alvoDeBusca([
      schema.listings.title,
      schema.listings.brand,
      schema.listings.description,
      nomeDoVendedor,
    ]);

  /** Ids que o termo devolve, na vitrine (só anúncios ativos). */
  const buscar = async (termo: string): Promise<string[]> => {
    const cond = condicaoDeBusca(alvo(), termo);
    const linhas = await db
      .select({ id: schema.listings.id })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .leftJoin(
        schema.sellerProfiles,
        eq(schema.sellerProfiles.userId, schema.listings.sellerId),
      )
      .where(
        cond
          ? and(eq(schema.listings.status, 'active'), cond)
          : eq(schema.listings.status, 'active'),
      );
    return linhas.map((l) => l.id).sort();
  };

  beforeAll(async () => {
    client = createClient({ url: ':memory:' });
    db = drizzle(client, { schema });

    await client.execute(
      `create table users (id text primary key, email text, name text, avatar_url text)`,
    );
    await client.execute(
      `create table seller_profiles (id text primary key, user_id text, store_name text, avatar_url text)`,
    );
    await client.execute(
      `create table listings (id text primary key, seller_id text, title text,
       brand text, description text, status text)`,
    );
    await client.execute(
      `insert into users (id, email, name) values ('s1','a@a','Culture TCG')`,
    );
    await client.batch([
      `insert into listings (id, seller_id, title, brand, description, status)
       values ('1','s1','Carta Pokémon Charizard','Wizards','Rara, 50% de desconto','active')`,
      `insert into listings (id, seller_id, title, brand, description, status)
       values ('2','s1','Hot Wheels Ferrari Testarossa','Mattel','Miniatura','active')`,
      `insert into listings (id, seller_id, title, brand, description, status)
       values ('3','s1','MANGÁ Naruto EDIÇÃO Especial','Panini','Coleção completa','active')`,
      `insert into listings (id, seller_id, title, brand, description, status)
       values ('4','s1','Pokémon rascunho','Wizards','Não publicado','draft')`,
    ]);
  });

  afterAll(() => client?.close());

  it('acha com acento quem digitou sem acento', async () => {
    await expect(buscar('pokemon')).resolves.toEqual(['1']);
  });

  it('acha acento em CAIXA ALTA no título', async () => {
    await expect(buscar('manga')).resolves.toEqual(['3']);
    await expect(buscar('edicao')).resolves.toEqual(['3']);
  });

  it('ignora a caixa do que foi digitado', async () => {
    await expect(buscar('POKÉMON')).resolves.toEqual(['1']);
  });

  it('casa todas as palavras, em qualquer ordem', async () => {
    await expect(buscar('ferrari hot wheels')).resolves.toEqual(['2']);
    await expect(buscar('pokemon ferrari')).resolves.toEqual([]);
  });

  it('procura também na marca, na descrição e no nome da loja', async () => {
    await expect(buscar('mattel')).resolves.toEqual(['2']);
    await expect(buscar('colecao completa')).resolves.toEqual(['3']);
    await expect(buscar('culture tcg')).resolves.toEqual(['1', '2', '3']);
  });

  it('não deixa o termo virar curinga do LIKE', async () => {
    // '%' sozinho casaria com tudo se não fosse escapado; aqui só casa o
    // anúncio que tem '%' escrito mesmo.
    await expect(buscar('%')).resolves.toEqual(['1']);
    await expect(buscar('50%')).resolves.toEqual(['1']);
    await expect(buscar('_')).resolves.toEqual([]);
  });

  it('termo vazio não filtra nada (devolve a vitrine)', async () => {
    expect(condicaoDeBusca(alvo(), '   ')).toBeUndefined();
    await expect(buscar('   ')).resolves.toEqual(['1', '2', '3']);
  });

  it('termo colado não estoura o parser do SQLite', async () => {
    // O limite fica entre 24 e 29 chamadas aninhadas; o corte em 6 palavras e a
    // normalização em duas passadas rasas mantêm a consulta abaixo disso.
    const termo =
      'pokemon charizard rara wizards carta desconto extra ignorado';
    expect(palavrasDoTermo(termo)).toHaveLength(6);
    await expect(buscar(termo)).resolves.toEqual(['1']);
  });

  it('funciona na contagem, que não projeta o nome do vendedor', async () => {
    // A paginação conta com os mesmos filtros. Se a expressão do vendedor
    // entrasse como apelido, aqui viraria "no such column: seller_name".
    const cond = condicaoDeBusca(alvo(), 'culture')!;
    const [linha] = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.listings)
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .leftJoin(
        schema.sellerProfiles,
        eq(schema.sellerProfiles.userId, schema.listings.sellerId),
      )
      .where(and(eq(schema.listings.status, 'active'), cond));

    expect(Number(linha.total)).toBe(3);
  });
});
