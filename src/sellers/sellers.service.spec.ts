import { SellersService } from './sellers.service';

/**
 * A vitrine da loja escondia TODO leilão — rodando, pausado ou encerrado.
 *
 * `getSellerListings` selecionava só a tabela `listings`, sem juntar `auctions`.
 * O anúncio chegava ao front com `type: 'auction'` e sem `endsAt`, e a regra de
 * visibilidade (`leilaoAberto`, no front) trata leilão sem fim como leilão nunca
 * iniciado e o descarta. Resultado: 110 anúncios de leilão ativos apareciam na
 * home e na busca — que usam `/api/listings`, com o join — e sumiam da loja do
 * próprio vendedor.
 *
 * O que estes testes prendem no lugar é o CONTRATO da resposta: os campos do
 * leilão precisam vir junto. Sem eles o front não tem como decidir e esconde.
 */
describe('SellersService.getSellerListings', () => {
  const SELLER = 'user_abc';

  /**
   * Captura o objeto passado a CADA `.select()` e os joins pedidos.
   *
   * São dois selects por chamada — o dos dados e o da contagem. Guardar só o
   * último devolvia o `{ count }` da contagem no lugar dos campos do anúncio.
   */
  const makeMockDb = (rows: any[]) => {
    const chain: any = {
      selects: [] as any[],
      leftJoinChamado: false,
      select: jest.fn(function (this: any, campos: any) {
        this.selects.push(campos);
        return this;
      }),
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn(function (this: any) {
        this.leftJoinChamado = true;
        return this;
      }),
      where: jest.fn().mockReturnThis(),
      // A vitrine passou a ser ordenada pelo vendedor (coluna `position`) e a
      // consulta ganhou um `.orderBy()`. O dublê não tinha o método, e os
      // quatro testes morriam com "orderBy is not a function", que parece falha
      // do recurso novo e era só o mock desatualizado.
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockResolvedValue(rows),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ count: rows.length }),
    };
    return chain;
  };

  const build = (rows: any[]) => {
    const db = makeMockDb(rows);
    return { db, service: new SellersService(db as any) };
  };

  /** O select da query de DADOS é o primeiro; o segundo é o da contagem. */
  const camposDoAnuncio = (db: any) => db.selects[0];

  it('traz os campos do leilão junto do anúncio', async () => {
    const { db, service } = build([]);

    await service.getSellerListings(SELLER, 1, 10);

    expect(db.leftJoinChamado).toBe(true);
    // Sem `endsAt` o front esconde o leilão — é o campo que originou o bug.
    expect(Object.keys(camposDoAnuncio(db))).toEqual(
      expect.arrayContaining([
        'endsAt',
        'auctionStatus',
        'auctionPausedAt',
        'auctionId',
      ]),
    );
  });

  // Pausado e nunca-iniciado compartilham o `endsAt` sentinela de 2099; só
  // `auctionPausedAt` separa os dois. Se ele sumir, deixa de ser possível
  // mostrar "pausado" no lugar de esconder o anúncio.
  it('distingue leilão pausado de leilão nunca iniciado', async () => {
    const { db, service } = build([]);

    await service.getSellerListings(SELLER, 1, 10);

    expect(camposDoAnuncio(db)).toHaveProperty('auctionPausedAt');
  });

  // O card escreve "{bidsCount} lances" sem proteção: faltando o campo, a loja
  // exibia "undefined lances".
  it('traz a contagem de lances que o card imprime', async () => {
    const { db, service } = build([]);

    await service.getSellerListings(SELLER, 1, 10);

    expect(camposDoAnuncio(db)).toHaveProperty('bidsCount');
  });

  it('mantém a paginação sobre os anúncios do vendedor', async () => {
    const { db, service } = build([{ id: 'l1' }, { id: 'l2' }]);

    const r = await service.getSellerListings(SELLER, 2, 10);

    expect(db.limit).toHaveBeenCalledWith(10);
    expect(db.offset).toHaveBeenCalledWith(10); // (página 2 - 1) * 10
    expect(r.data).toHaveLength(2);
    expect(r.meta.page).toBe(2);
  });
});

/**
 * Transportadoras que o vendedor topa usar.
 *
 * A escolha RESTRINGE o que a plataforma libera, nunca amplia. E há um piso: sem
 * pelo menos uma transportadora de cobertura nacional, o vendedor que marcasse
 * só a da esquina perderia toda venda fora da região dela sem nunca saber. O
 * comprador de outro estado não vê frete, não fecha a compra e vai embora: não
 * aparece erro na tela de ninguém.
 */
describe('SellersService.updateMyShipping', () => {
  const USER = 'user_abc';

  const build = () => {
    const gravado: any[] = [];
    const db: any = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ userId: USER, shippingServices: null }),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      run: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockReturnThis(),
      set: jest.fn((patch: any) => {
        gravado.push(patch);
        return db;
      }),
    };
    return { db, gravado, service: new SellersService(db as any) };
  };

  beforeEach(() => {
    process.env.MELHOR_ENVIO_SERVICOS = '1,2,3,17,31,33';
  });

  it('grava a escolha como CSV ordenado', async () => {
    const { service, gravado } = build();

    await service.updateMyShipping(USER, [33, 1]);

    expect(gravado[0]).toEqual({ shippingServices: '1,33' });
  });

  it('lista vazia volta ao padrão da plataforma', async () => {
    // Saída de emergência: o vendedor sempre desfaz a própria escolha sozinho.
    const { service, gravado } = build();

    await service.updateMyShipping(USER, []);

    expect(gravado[0]).toEqual({ shippingServices: null });
  });

  it('recusa serviço que a plataforma não libera, em vez de ignorar calado', async () => {
    // Salvar "ok" e guardar outra coisa é como o vendedor descobre semanas
    // depois que a configuração dele nunca valeu.
    const { service } = build();

    await expect(service.updateMyShipping(USER, [1, 4])).rejects.toThrow(
      /Jadlog \.Com/,
    );
  });

  it('exige pelo menos uma transportadora de cobertura nacional', async () => {
    const { service } = build();

    await expect(service.updateMyShipping(USER, [31, 33])).rejects.toThrow(
      /cobertura nacional/,
    );
  });

  it('Mini Envios sozinho não conta como cobertura nacional', async () => {
    // É nacional, mas trava em 300 g: "só Mini Envios" deixa sem frete a maior
    // parte do que se vende aqui.
    const { service } = build();

    await expect(service.updateMyShipping(USER, [17, 31])).rejects.toThrow(
      /cobertura nacional/,
    );
  });

  it('PAC ou SEDEX satisfazem o piso', async () => {
    const { service, gravado } = build();

    await service.updateMyShipping(USER, [1, 31]);

    expect(gravado[0]).toEqual({ shippingServices: '1,31' });
  });
});

/**
 * O nome que aparece na loja é o do PAINEL DA KOLECTA, não o do Clerk.
 *
 * `users.name` vem do webhook do Clerk e é reescrito a cada `user.updated` —
 * mexer no nome da CONTA DE E-MAIL renomeava a loja. A vitrine e o leilão já
 * resolviam pelo `store_name`; este endpoint, que serve justamente a página da
 * loja (`/vendedor/:id` e `kolecta.com.br/<slug>`), lia `users.name` cru. O
 * comprador via "Culture TCG" no card e o nome pessoal do dono ao clicar nele,
 * inclusive no `<title>` que vai para o Google — enquanto a URL, gerada do
 * `store_name`, dizia outra coisa na mesma página.
 */
describe('SellersService.getSellerProfile', () => {
  const SELLER = 'user_abc';

  const build = () => {
    const selects: any[] = [];
    const db: any = {
      select: jest.fn((campos: any) => {
        selects.push(campos);
        return db;
      }),
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ id: SELLER }),
    };
    return { db, selects, service: new SellersService(db as any) };
  };

  /**
   * Colunas que uma expressão SQL do drizzle referencia, NA ORDEM — que aqui é
   * a própria regra: quem vem primeiro no COALESCE é quem prevalece.
   */
  const colunasDe = (expr: any): string[] =>
    (expr?.queryChunks ?? [])
      .filter((c: any) => typeof c?.name === 'string')
      .map((c: any) => c.name);

  /** O select do perfil é o primeiro; os seguintes são as agregações. */
  const camposDoPerfil = (selects: any[]) => selects[0];

  it('resolve o nome pelo store_name ANTES de cair no users.name', async () => {
    const { selects, service } = build();

    await service.getSellerProfile(SELLER);

    expect(colunasDe(camposDoPerfil(selects).name)).toEqual([
      'store_name',
      'name',
    ]);
  });

  it('não devolve mais o users.name cru como nome da loja', async () => {
    // Regressão: bastava trocar a expressão pela coluna para o nome do Clerk
    // voltar a mandar, e nenhum teste acusaria.
    const { selects, service } = build();

    await service.getSellerProfile(SELLER);

    expect(colunasDe(camposDoPerfil(selects).name)).not.toEqual(['name']);
  });

  it('mantém store_name e slug à parte do nome resolvido', async () => {
    // `name` agora vem sempre resolvido, então deixou de ser possível saber
    // por ele se a loja TEM nome próprio ou está caindo no do dono. Quem
    // precisar da distinção — e o `slug`, que a página usa na URL canônica —
    // continua tendo os campos crus aqui.
    const { selects, service } = build();

    await service.getSellerProfile(SELLER);

    expect(camposDoPerfil(selects)).toHaveProperty('storeName');
    expect(camposDoPerfil(selects)).toHaveProperty('slug');
  });
});
