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
