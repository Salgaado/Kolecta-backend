/**
 * O cartão está FECHADO por padrão (`payment-flags.ts`) enquanto o antifraude
 * da Pagar.me reprova toda cobrança. Estes testes cobrem o cartão funcionando,
 * então ligam o interruptor antes do import — a flag é lida no carregamento do
 * módulo.
 */
process.env.PAGAMENTO_CARTAO_HABILITADO = 'true';
/**
 * Recebedor da plataforma. Sem ele, lance e pagamento de arremate são
 * RECUSADOS em vez de seguirem sem split (ver `docs/PLAN-pagarme-conta-nova.md`,
 * Fase 1). Lido no carregamento do módulo, por isso vem antes do import.
 */
process.env.PAGARME_PLATFORM_RECIPIENT_ID = 're_platform';

import { Test, TestingModule } from '@nestjs/testing';
import { AuctionsService } from './auctions.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { WalletService } from '../wallet/wallet.service';
import { FounderService } from '../founder/founder.service';
import { CardsService } from '../cards/cards.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { ShippingService } from '../shipping/shipping.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Emissor de eventos: só precisamos observar o que foi emitido.
const mockEventEmitter = { emit: jest.fn() };

/**
 * Cotação de frete. `raw.id` é o que identifica o serviço no Melhor Envio — e é
 * por ele que `chooseShipping` casa a escolha do comprador com o preço do
 * servidor. Opção sem `raw.id` é o mock que o ShippingService devolve quando a
 * API está fora, e o serviço tem que recusar.
 */
const mockShippingService = {
  quoteShipping: jest.fn().mockResolvedValue({
    pickup: true,
    options: [
      {
        carrier: 'Correios',
        service: 'PAC',
        price: 15.5,
        delivery_time_days: 7,
        raw: { id: 1 },
      },
      {
        carrier: 'Correios',
        service: 'SEDEX',
        price: 32.9,
        delivery_time_days: 2,
        raw: { id: 2 },
      },
    ],
  }),
};
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';

const mockWallet = {
  id: 'wallet_seller',
  userId: 'seller_001',
  balanceInCents: 0,
  pendingInCents: 0,
};

const mockWalletService = {
  getOrCreateWallet: jest.fn().mockResolvedValue(mockWallet),
  hold: jest.fn().mockResolvedValue({ success: true }),
};

const mockFounderService = {
  resolveCommissionPercent: jest.fn().mockResolvedValue(11),
};

// Cartão salvo do bidder (referência interna customer + card_id).
const mockCardsService = {
  getCardRef: jest
    .fn()
    .mockResolvedValue({ customerId: 'cus_1', cardId: 'card_1' }),
};

// Pré-auth padrão, na forma que a API REAL devolve (conferido em sandbox
// 30/07): a cobrança fica `pending` e quem carrega `authorized_pending_capture`
// é a TRANSAÇÃO. O mock antigo punha esse status na cobrança — forma que a
// Pagar.me nunca retorna, o que fazia o teste validar uma resposta imaginária.
const authorizedOrder = {
  id: 'or_1',
  status: 'pending',
  charges: [
    {
      id: 'ch_1',
      status: 'pending',
      last_transaction: { status: 'authorized_pending_capture' },
    },
  ],
};

const mockPagarmeService = {
  post: jest.fn().mockResolvedValue(authorizedOrder),
  delete: jest.fn().mockResolvedValue({}),
  // Consulta do estado real da retenção. Default: de pé — assim os testes que
  // não falam de retenção solta seguem exercitando só o caminho da validade.
  get: jest.fn().mockResolvedValue({
    status: 'pending',
    last_transaction: { status: 'authorized_pending_capture' },
  }),
};

const sellerId = 'seller_001';
const bidderId = 'buyer_001';
const mockListingId = 'listing_auction_001';
const mockAuctionId = 'auction_001';

const mockListing = {
  id: mockListingId,
  sellerId,
  type: 'auction',
  status: 'active',
  priceInCents: null,
};

const mockAuction = {
  id: mockAuctionId,
  listingId: mockListingId,
  startingBidInCents: 5000,
  minIncrementInCents: 1000,
  currentBidInCents: 5000,
  currentWinnerId: null,
  reservePriceInCents: null,
  durationHours: 48,
  endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
  antiSniper: true,
  status: 'active',
};

const mockBid = {
  id: 'bid_001',
  auctionId: mockAuctionId,
  bidderId,
  amountInCents: 6000,
  createdAt: new Date(),
};

// Builder de mock Drizzle com encadeamento completo
//
// Estratégia: `where` retorna `chain` por padrão para suportar o padrão
//   update().set().where().returning()
// e também select().from().innerJoin().where().orderBy().
// Testes que precisam de `where` como terminal usam mockResolvedValueOnce.
const makeDrizzleMock = () => {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain); // retorna chain por padrão
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  // Vendedor + perfil de loja entram por leftJoin (nome do vendedor no leilão).
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockResolvedValue([mockBid]);
  chain.groupBy = jest.fn().mockResolvedValue([]); // contagem de lances por leilão
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.offset = jest.fn().mockReturnValue(chain);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue([mockAuction]);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.set = jest.fn().mockReturnValue(chain);
  // Guarda cada tx: o insert do pedido acontece DENTRO da transação, então é
  // no tx (e não no chain) que ficam os valores a inspecionar.
  chain.txs = [] as any[];
  chain.transaction = jest.fn().mockImplementation(async (fn: any) => {
    const tx: any = {};
    tx.insert = jest.fn().mockReturnValue(tx);
    tx.values = jest.fn().mockReturnValue(tx);
    // returning() é usado tanto pelo insert do lance quanto pelo update-guard;
    // por padrão resolve não-vazio (lance registrado + update aplicado).
    tx.returning = jest.fn().mockResolvedValue([mockBid]);
    tx.update = jest.fn().mockReturnValue(tx);
    tx.set = jest.fn().mockReturnValue(tx);
    tx.where = jest.fn().mockReturnValue(tx);
    chain.txs.push(tx);
    return fn(tx);
  });
  return chain;
};

const mockEndereco = {
  id: 'addr_1',
  userId: 'user_bidder',
  street: 'Rua Teste',
  number: '100',
  complement: null,
  neighborhood: 'Centro',
  city: 'Sao Paulo',
  state: 'SP',
  zip: '01310-100',
  country: 'BR',
  isDefault: true,
};

describe('AuctionsService', () => {
  let service: AuctionsService;
  let mockDb: any;

  const buildModule = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuctionsService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
        { provide: WalletService, useValue: mockWalletService },
        { provide: FounderService, useValue: mockFounderService },
        { provide: CardsService, useValue: mockCardsService },
        { provide: PagarmeService, useValue: mockPagarmeService },
        { provide: ShippingService, useValue: mockShippingService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    return module.get<AuctionsService>(AuctionsService);
  };

  beforeEach(() => {
    // Restaura defaults dos mocks compartilhados (evita vazamento de *Once).
    mockWalletService.getOrCreateWallet
      .mockReset()
      .mockResolvedValue(mockWallet);
    mockWalletService.hold.mockReset().mockResolvedValue({ success: true });
    mockFounderService.resolveCommissionPercent
      .mockReset()
      .mockResolvedValue(11);
    mockCardsService.getCardRef
      .mockReset()
      .mockResolvedValue({ customerId: 'cus_1', cardId: 'card_1' });
    mockPagarmeService.post.mockReset().mockResolvedValue(authorizedOrder);
    mockPagarmeService.delete.mockReset().mockResolvedValue({});
    mockShippingService.quoteShipping.mockReset().mockResolvedValue({
      pickup: true,
      options: [
        {
          carrier: 'Correios',
          service: 'PAC',
          price: 15.5,
          delivery_time_days: 7,
          raw: { id: 1 },
        },
        {
          carrier: 'Correios',
          service: 'SEDEX',
          price: 32.9,
          delivery_time_days: 2,
          raw: { id: 2 },
        },
      ],
    });
    mockEventEmitter.emit.mockReset();
  });

  // ── findById ─────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('deve lançar NotFoundException se leilão não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();

      await expect(service.findById('nope')).rejects.toThrow(NotFoundException);
    });

    it('deve retornar o leilão encontrado', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([mockAuction]);
      service = await buildModule();

      const result = await service.findById(mockAuctionId);
      expect(result).toEqual(mockAuction);
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('deve lançar NotFoundException se listing não pertence ao seller', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();

      await expect(
        service.create(sellerId, {
          listingId: mockListingId,
          startingBidInCents: 5000,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar BadRequestException se listing não é do tipo auction', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...mockListing, type: 'direct' }]);
      service = await buildModule();

      await expect(
        service.create(sellerId, {
          listingId: mockListingId,
          startingBidInCents: 5000,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── placeBid ──────────────────────────────────────────────────────────────

  describe('placeBid', () => {
    it('deve lançar NotFoundException se leilão não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();

      await expect(
        service.placeBid('nope', bidderId, { amountInCents: 6000 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar ForbiddenException se bidder é o seller do listing', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction]) // auction found
        .mockResolvedValueOnce([mockListing]); // listing with same sellerId
      service = await buildModule();

      await expect(
        service.placeBid(mockAuctionId, sellerId, { amountInCents: 6000 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deve lançar BadRequestException se lance é menor que o mínimo', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction]) // auction
        .mockResolvedValueOnce([
          { ...mockListing, sellerId: 'another_seller' },
        ]); // listing different seller
      service = await buildModule();

      await expect(
        // currentBid=5000, minIncrement=1000 → mínimo=6001, tentando 5000
        service.placeBid(mockAuctionId, bidderId, { amountInCents: 5000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar BadRequestException se o bidder não tem cartão salvo', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([
          { ...mockListing, sellerId: 'another_seller' },
        ]);
      mockCardsService.getCardRef.mockReset().mockResolvedValue(null);
      service = await buildModule();

      await expect(
        service.placeBid(mockAuctionId, bidderId, { amountInCents: 6100 }),
      ).rejects.toThrow(BadRequestException);
      // Sem cartão → nem tenta autorizar na Pagar.me.
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('deve lançar BadRequestException se o cartão é recusado na pré-auth', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança do bidder
      mockPagarmeService.post.mockReset().mockResolvedValue({
        id: 'or_x',
        status: 'failed',
        charges: [{ id: 'ch_x', status: 'failed' }],
      });
      service = await buildModule();

      await expect(
        service.placeBid(mockAuctionId, bidderId, { amountInCents: 6100 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve registrar lance com sucesso (pré-auth no cartão)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança do bidder
      service = await buildModule();

      const result = await service.placeBid(mockAuctionId, bidderId, {
        amountInCents: 6100, // > 5000 + 1000
      });

      expect(result).toEqual(mockBid);
      // Criou a pré-autorização (capture:false) na Pagar.me.
      expect(mockPagarmeService.post).toHaveBeenCalledWith(
        '/orders',
        expect.objectContaining({
          customer_id: 'cus_1',
          payments: expect.arrayContaining([
            expect.objectContaining({
              credit_card: expect.objectContaining({
                capture: false,
                card_id: 'card_1',
              }),
            }),
          ]),
        }),
        expect.any(String),
      );
    });

    it('deve lançar ConflictException e cancelar a pré-auth se perder a corrida', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança do bidder

      // Transaction em que o UPDATE condicional não afeta linhas (returning vazio),
      // simulando que um lance igual/maior chegou primeiro.
      mockDb.transaction = jest.fn().mockImplementation(async (fn: any) => {
        const tx: any = {};
        tx.insert = jest.fn().mockReturnValue(tx);
        tx.values = jest.fn().mockReturnValue(tx);
        tx.update = jest.fn().mockReturnValue(tx);
        tx.set = jest.fn().mockReturnValue(tx);
        tx.where = jest.fn().mockReturnValue(tx);
        // 1ª chamada (insert do lance) → não-vazio; 2ª (update-guard) → vazio
        tx.returning = jest
          .fn()
          .mockResolvedValueOnce([mockBid])
          .mockResolvedValueOnce([]);
        return fn(tx);
      });

      service = await buildModule();

      await expect(
        service.placeBid(mockAuctionId, bidderId, { amountInCents: 6100 }),
      ).rejects.toThrow(ConflictException);
      // Rollback: a pré-auth recém-criada é cancelada (void).
      expect(mockPagarmeService.delete).toHaveBeenCalledWith('/charges/ch_1');
    });
  });

  // ── findSellerAuctions ────────────────────────────────────────────────────

  describe('findSellerAuctions', () => {
    it('deve retornar array de leilões do seller', async () => {
      const sellerAuction = { ...mockAuction, sellerId };
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([sellerAuction]);
      service = await buildModule();

      const result = await service.findSellerAuctions(sellerId);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
    });

    it('deve chamar innerJoin para buscar dados do listing', async () => {
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([]);
      service = await buildModule();

      await service.findSellerAuctions(sellerId);

      expect(mockDb.innerJoin).toHaveBeenCalled();
    });

    it('deve retornar array vazio se o seller não tem leilões', async () => {
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([]);
      service = await buildModule();

      const result = await service.findSellerAuctions('seller_sem_leiloes');

      expect(result).toEqual([]);
    });
  });

  // ── endAuction ────────────────────────────────────────────────────────────

  /**
   * O leilão não passa por checkout, então o pedido nascia sem endereço e a
   * etiqueta do Melhor Envio nem chegava a ser pedida ("Pedido sem endereço de
   * entrega"). O endereço agora vem do cadastro do vencedor.
   */
  describe('_getDefaultAddressId', () => {
    const chamar = async (enderecos: any[]) => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce(enderecos);
      service = await buildModule();
      return (service as any)._getDefaultAddressId('user_1');
    };

    it('prefere o endereço marcado como padrão', async () => {
      await expect(
        chamar([
          { id: 'end_a', isDefault: false },
          { id: 'end_b', isDefault: true },
        ]),
      ).resolves.toBe('end_b');
    });

    it('cai no primeiro quando nenhum é padrão', async () => {
      await expect(chamar([{ id: 'end_a', isDefault: false }])).resolves.toBe(
        'end_a',
      );
    });

    it('devolve null quando o usuário não tem endereço', async () => {
      await expect(chamar([])).resolves.toBeNull();
    });
  });

  describe('endAuction', () => {
    it('deve lançar NotFoundException se leilão não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // auction não encontrado
      service = await buildModule();

      await expect(
        service.endAuction('auction_nope', sellerId),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar BadRequestException se leilão não está ativo', async () => {
      const endedAuction = { ...mockAuction, status: 'ended' };
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([endedAuction]);
      service = await buildModule();

      await expect(service.endAuction(mockAuctionId, sellerId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('deve lançar ForbiddenException se requester não é seller nem admin', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction]) // auction ativo
        .mockResolvedValueOnce([mockListing]) // listing com sellerId diferente
        .mockResolvedValueOnce([{ id: 'outro_user', role: 'user' }]); // requester não é admin
      service = await buildModule();

      await expect(
        service.endAuction(mockAuctionId, 'outro_user'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deve encerrar o leilão quando o requester é o seller (sem vencedor)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction]) // auction ativo (sem vencedor)
        .mockResolvedValueOnce([mockListing]) // listing pertence ao seller
        .mockResolvedValueOnce([{ id: sellerId, role: 'user' }]); // requester é o seller
      service = await buildModule();

      // Leilão sem vencedor → _closeAuction encerra via db.update (sem tx).
      await expect(
        service.endAuction(mockAuctionId, sellerId),
      ).resolves.not.toThrow();

      expect(mockDb.update).toHaveBeenCalled();
    });

    it('deve encerrar o leilão quando o requester é admin', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction]) // auction ativo
        .mockResolvedValueOnce([mockListing]) // listing (seller diferente)
        .mockResolvedValueOnce([{ id: 'admin_user', role: 'admin' }]); // requester é admin
      service = await buildModule();

      await expect(
        service.endAuction(mockAuctionId, 'admin_user'),
      ).resolves.not.toThrow();

      expect(mockDb.update).toHaveBeenCalled();
    });

    /**
     * O fecho NÃO cobra mais nada.
     *
     * O lance cobre só a peça; o frete é escolhido pelo vencedor depois e entra
     * no MESMO total. Como não se captura acima do valor autorizado, capturar
     * aqui obrigaria a uma segunda cobrança só do frete. O pedido nasce
     * `pending_payment` e a pré-auth vira garantia.
     */
    const fecharComVencedor = async () => {
      const winnerAuction = {
        ...mockAuction,
        currentWinnerId: bidderId,
        currentBidInCents: 6000,
      };
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([winnerAuction]) // auction (com vencedor)
        .mockResolvedValueOnce([mockListing]) // listing
        .mockResolvedValueOnce([{ id: sellerId, role: 'user' }]) // requester = seller
        .mockResolvedValueOnce([{ chargeId: 'ch_1', orderId: 'or_1' }]) // _getActiveBidAuth
        .mockResolvedValueOnce([{ id: 'end_1', isDefault: true }]); // endereço do vencedor
      service = await buildModule();
      await service.endAuction(mockAuctionId, sellerId);
      return mockDb.txs
        .flatMap((tx: any) => tx.values.mock.calls)
        .map((c: any[]) => c[0])
        .find((v: any) => v?.buyerId === bidderId);
    };

    it('NÃO captura a pré-auth no fecho: pedido nasce pending_payment sem frete', async () => {
      const pedido = await fecharComVencedor();

      // Nada de captura — o total ainda vai crescer com o frete.
      expect(mockPagarmeService.post).not.toHaveBeenCalledWith(
        expect.stringContaining('/capture'),
        expect.anything(),
        expect.anything(),
      );
      expect(pedido?.status).toBe('pending_payment');
      expect(pedido?.totalInCents).toBe(6000);
      expect(pedido?.shippingInCents).toBe(0);
      // O pedido nasce COM endereço: é dele que sai a cotação do frete.
      expect(pedido?.addressId).toBe('end_1');
      // Sem cobrança não há líquido a reter ainda.
      expect(mockWalletService.hold).not.toHaveBeenCalled();
    });

    it('mantém a pré-auth de pé no fecho (é a garantia enquanto ele escolhe)', async () => {
      await fecharComVencedor();

      // Cancelar aqui deixaria o arremate sem garantia nenhuma até o pagamento.
      expect(mockPagarmeService.delete).not.toHaveBeenCalled();
    });

    it('avisa o vencedor que falta escolher o frete', async () => {
      await fecharComVencedor();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'auction.won',
        expect.objectContaining({
          winnerId: bidderId,
          needsPayment: true,
          needsShippingChoice: true,
        }),
      );
    });
  });

  // ── endExpiredAuctions ────────────────────────────────────────────────────

  describe('endExpiredAuctions', () => {
    it('deve retornar array vazio se não há leilões expirados', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // nenhum leilão expirado
      service = await buildModule();

      const result = await service.endExpiredAuctions();

      expect(result).toEqual([]);
    });

    it('deve retornar IDs dos leilões que foram fechados', async () => {
      const expiredAuction = {
        ...mockAuction,
        id: 'auction_expired',
        endsAt: new Date(Date.now() - 1000), // já expirou
      };
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([expiredAuction]) // leilões expirados
        .mockResolvedValueOnce([mockListing]); // listing do leilão expirado
      service = await buildModule();

      const result = await service.endExpiredAuctions();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toContain('auction_expired');
    });

    it('deve continuar processando mesmo se um leilão falhar', async () => {
      const expiredAuction1 = {
        ...mockAuction,
        id: 'auction_exp_1',
        endsAt: new Date(Date.now() - 1000),
      };
      const expiredAuction2 = {
        ...mockAuction,
        id: 'auction_exp_2',
        endsAt: new Date(Date.now() - 2000),
      };
      mockDb = makeDrizzleMock();
      // Retorna 2 expirados
      mockDb.where
        .mockResolvedValueOnce([expiredAuction1, expiredAuction2])
        .mockResolvedValueOnce([mockListing]) // listing para o primeiro
        .mockResolvedValueOnce([mockListing]); // listing para o segundo

      service = await buildModule();
      // Falha só no fechamento do 1º leilão (resolveCommissionPercent é o
      // primeiro await de _closeAuction) → deve ser capturada e seguir p/ o 2º.
      mockFounderService.resolveCommissionPercent
        .mockReset()
        .mockRejectedValueOnce(new Error('Falha simulada'))
        .mockResolvedValue(11);

      const result = await service.endExpiredAuctions();

      // Só o segundo deve ter sido fechado com sucesso
      expect(result).toContain('auction_exp_2');
      expect(result).not.toContain('auction_exp_1');
    });
  });

  // ── Retomada automática ao vendedor ficar apto ───────────────────────────
  //
  // Na migração para a conta nova (31/07/2026) os 110 leilões foram pausados:
  // sem recebedor ativo o lance é recusado, e leilão visível onde ninguém
  // consegue dar lance é pior que leilão fora do ar — o comprador culpa a
  // plataforma e o vendedor perde a venda sem saber por quê. Conforme cada um
  // refaz o cadastro, os leilões dele voltam sozinhos.

  describe('retomarLeiloesDoVendedor', () => {
    it('devolve o leilão com o tempo que FALTAVA, não com o relógio corrido', async () => {
      mockDb = makeDrizzleMock();
      const doisDiasMs = 2 * 24 * 60 * 60 * 1000;
      mockDb.where.mockResolvedValueOnce([
        { id: 'auction_1', restanteMs: doisDiasMs },
      ]);
      service = await buildModule();

      const antes = Date.now();
      const total = await service.retomarLeiloesDoVendedor({
        sellerId: 'user_seller',
      });

      expect(total).toBe(1);
      const patch = mockDb.set.mock.calls[0][0];
      expect(patch.pausedAt).toBeNull();
      expect(patch.pausedRemainingMs).toBeNull();
      // Novo fim ≈ agora + o que faltava (folga de 5s para o relógio do teste).
      const esperado = antes + doisDiasMs;
      expect(
        Math.abs(new Date(patch.endsAt).getTime() - esperado),
      ).toBeLessThan(5000);
    });

    it('não faz nada quando o vendedor não tem leilão pausado', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();

      const total = await service.retomarLeiloesDoVendedor({
        sellerId: 'user_seller',
      });

      // Idempotência: `recipient.updated` chega várias vezes para o mesmo
      // vendedor, e a segunda não pode reiniciar relógio de leilão já no ar.
      expect(total).toBe(0);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  // ── reauthorizeExpiringBids (Fase 3) ─────────────────────────────────────

  describe('reauthorizeExpiringBids', () => {
    // Vence daqui a 1h: dentro da janela de renovação (24h), que é o caminho
    // pela DATA. O caminho por VERIFICAÇÃO usa `reauthRowLonge`, abaixo.
    const reauthRow = {
      bidId: 'bid_001',
      auctionId: mockAuctionId,
      bidderId,
      amountInCents: 6000,
      chargeId: 'ch_old',
      authExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      sellerId,
    };

    /** Mesmo lance, mas com validade longe: só renova se a retenção sumiu. */
    const reauthRowLonge = {
      ...reauthRow,
      authExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    };

    it('não faz nada quando não há pré-auth a expirar', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // nenhum lance na janela
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result).toEqual({ reauthorized: [], failed: [] });
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('renova a pré-auth: cria uma nova e cancela a antiga', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([reauthRow]) // lances líderes a expirar
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança do bidder
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result.reauthorized).toContain('bid_001');
      expect(result.failed).toEqual([]);
      // Criou nova pré-auth (capture:false).
      expect(mockPagarmeService.post).toHaveBeenCalledWith(
        '/orders',
        expect.objectContaining({
          payments: expect.arrayContaining([
            expect.objectContaining({
              credit_card: expect.objectContaining({ capture: false }),
            }),
          ]),
        }),
        expect.any(String),
      );
      // Cancelou a auth ANTIGA.
      expect(mockPagarmeService.delete).toHaveBeenCalledWith('/charges/ch_old');
    });

    it('pula (sem renovar) quando o bidder não tem mais cartão salvo', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([reauthRow]);
      mockCardsService.getCardRef.mockReset().mockResolvedValue(null);
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result.reauthorized).toEqual([]);
      expect(result.failed).toEqual([]);
      // Sem cartão → não tenta autorizar nem cancela a auth antiga.
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
      expect(mockPagarmeService.delete).not.toHaveBeenCalled();
    });

    it('desfaz a auth NOVA e não conta como renovada se o lance mudou no meio', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([reauthRow])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança
      // Troca atômica não afeta linhas (lance superado/fechado no meio).
      mockDb.returning.mockResolvedValueOnce([]);
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result.reauthorized).toEqual([]);
      // Rollback: cancela a auth NOVA (ch_1 do authorizedOrder), não a antiga.
      expect(mockPagarmeService.delete).toHaveBeenCalledWith('/charges/ch_1');
      expect(mockPagarmeService.delete).not.toHaveBeenCalledWith(
        '/charges/ch_old',
      );
    });

    it('marca como falha e MANTÉM a auth antiga se o cartão é recusado agora', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([reauthRow])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança
      // Cartão recusado na renovação.
      mockPagarmeService.post.mockReset().mockResolvedValue({
        id: 'or_x',
        status: 'failed',
        charges: [{ id: 'ch_x', status: 'failed' }],
      });
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result.failed).toContain('bid_001');
      expect(result.reauthorized).toEqual([]);
      // A auth ANTIGA é preservada (degrada para pending_payment no fecho).
      expect(mockPagarmeService.delete).not.toHaveBeenCalledWith(
        '/charges/ch_old',
      );
    });

    // ── Retenção devolvida antes do prazo ──────────────────────────────────
    //
    // `authExpiresAt` é estimativa nossa. Bandeira e banco emissor às vezes
    // liberam o saldo antes do prazo contratado e não avisam ninguém. Confiar
    // só na data faz a plataforma acreditar numa garantia inexistente até a
    // hora de capturar — com o leilão fechado e o vencedor já avisado.

    it('renova quando a retenção sumiu, mesmo com a validade longe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([reauthRowLonge])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([mockEndereco]);
      // O banco devolveu o saldo: a transação não está mais retida.
      mockPagarmeService.get.mockResolvedValueOnce({
        status: 'canceled',
        last_transaction: { status: 'voided' },
      });
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result.reauthorized).toContain('bid_001');
      expect(mockPagarmeService.get).toHaveBeenCalledWith('/charges/ch_old');
    });

    it('não renova quando a retenção segue de pé e a validade está longe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([reauthRowLonge]);
      mockPagarmeService.get.mockResolvedValueOnce({
        status: 'pending',
        last_transaction: { status: 'authorized_pending_capture' },
      });
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result).toEqual({ reauthorized: [], failed: [] });
      // Renovar à toa criaria uma SEGUNDA retenção no limite do comprador.
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('na dúvida (consulta falhou) NÃO renova — trata como retida', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([reauthRowLonge]);
      mockPagarmeService.get.mockRejectedValueOnce(
        new Error('502 bad gateway'),
      );
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      // Uma instabilidade do gateway não pode bloquear o limite de todos os
      // líderes de uma vez: dúvida degrada para o comportamento anterior.
      expect(result).toEqual({ reauthorized: [], failed: [] });
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('não gasta consulta com quem já vai renovar pela data', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([reauthRow]) // vence em 1h
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([mockEndereco]);
      service = await buildModule();
      mockPagarmeService.get.mockClear(); // o mock é compartilhado entre casos

      await service.reauthorizeExpiringBids();

      expect(mockPagarmeService.get).not.toHaveBeenCalled();
    });
  });

  // ── Frete do arremate (escolhido pelo vencedor, depois do fecho) ─────────

  describe('getAuctionShippingOptions / chooseShipping', () => {
    // Arremate recém-fechado: total = só o lance, sem frete, sem escolha.
    const arremate = {
      id: 'order_1',
      buyerId: bidderId,
      sellerId,
      listingId: mockListingId,
      addressId: 'addr_1',
      totalInCents: 6000,
      shippingInCents: 0,
      shippingServiceId: null,
      shippingServiceName: null,
      deliveryMethod: 'shipping',
      sellerNetInCents: 5340,
      platformFeeInCents: 660,
      status: 'pending_payment',
      paymentDeadlineAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    };

    // `db.query.addresses.findFirst` é caminho separado do chain de select.
    const stubQuery = (endereco: any = mockEndereco) => {
      mockDb.query = {
        addresses: { findFirst: jest.fn().mockResolvedValue(endereco) },
      };
    };

    it('lista as opções com o total (lance + frete) de cada uma', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      service = await buildModule();

      const r = await service.getAuctionShippingOptions(bidderId, 'order_1');

      expect(r.bidInCents).toBe(6000);
      expect(r.needsAddress).toBe(false);
      // Ordenadas da mais barata para a mais cara.
      expect(r.options.map((o: any) => o.serviceId)).toEqual([1, 2]);
      expect(r.options[0]).toMatchObject({
        name: 'Correios PAC',
        shippingInCents: 1550,
        totalInCents: 7550,
      });
    });

    it('descarta opção sem raw.id (mock do ShippingService com o ME fora)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      mockShippingService.quoteShipping.mockResolvedValueOnce({
        pickup: true,
        options: [
          { carrier: 'Correios', service: 'PAC', price: 25.9, raw: {} },
        ],
      });
      service = await buildModule();

      const r = await service.getAuctionShippingOptions(bidderId, 'order_1');

      // Cobrar um preço que não corresponde a serviço nenhum faria a etiqueta
      // sair por outro valor — melhor não oferecer.
      expect(r.options).toEqual([]);
    });

    it('sinaliza needsAddress quando o vencedor não tem endereço', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...arremate, addressId: null }]);
      stubQuery(null);
      service = await buildModule();

      const r = await service.getAuctionShippingOptions(bidderId, 'order_1');

      expect(r.needsAddress).toBe(true);
      expect(r.options).toEqual([]);
      expect(mockShippingService.quoteShipping).not.toHaveBeenCalled();
    });

    it('soma o frete ao total e manda o frete INTEIRO para a plataforma', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      service = await buildModule();

      const r = await service.chooseShipping(bidderId, 'order_1', {
        deliveryMethod: 'shipping',
        shippingServiceId: 1,
      });

      expect(r).toMatchObject({
        bidInCents: 6000,
        shippingInCents: 1550,
        totalInCents: 7550,
        shippingServiceName: 'Correios PAC',
      });
      const gravado = mockDb.set.mock.calls[0][0];
      expect(gravado.totalInCents).toBe(7550);
      expect(gravado.externalAmountInCents).toBe(7550);
      // Comissão (660, sobre o item) + frete inteiro (1550). O líquido do
      // vendedor não muda com o frete.
      expect(gravado.platformFeeInCents).toBe(2210);
      expect(gravado.shippingServiceId).toBe(1);
    });

    it('IGNORA preço vindo do cliente: usa o da recotagem no servidor', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      service = await buildModule();

      // O corpo não tem campo de preço; mesmo assim vale conferir que o valor
      // gravado veio da cotação, e não de nada que o comprador controle.
      const r = await service.chooseShipping(bidderId, 'order_1', {
        deliveryMethod: 'shipping',
        shippingServiceId: 2,
      } as any);

      expect(r.shippingInCents).toBe(3290); // SEDEX da cotação, não 0
      expect(r.totalInCents).toBe(9290);
    });

    it('recusa serviço que não está mais na cotação do endereço', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 999,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('é idempotente: trocar de opção não acumula frete sobre frete', async () => {
      // Pedido que JÁ tem SEDEX escolhido; agora ele troca para PAC.
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([
        {
          ...arremate,
          totalInCents: 9290, // 6000 + 3290
          shippingInCents: 3290,
          shippingServiceId: 2,
          shippingServiceName: 'Correios SEDEX',
          platformFeeInCents: 3950, // 660 + 3290
        },
      ]);
      stubQuery();
      service = await buildModule();

      const r = await service.chooseShipping(bidderId, 'order_1', {
        deliveryMethod: 'shipping',
        shippingServiceId: 1,
      });

      // Volta a partir do LANCE, não do total anterior.
      expect(r.bidInCents).toBe(6000);
      expect(r.totalInCents).toBe(7550);
      expect(mockDb.set.mock.calls[0][0].platformFeeInCents).toBe(2210);
    });

    it('retirada em mãos zera o frete e mantém o total no valor do lance', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([arremate])
        .mockResolvedValueOnce([{ acceptsPickup: true }]);
      stubQuery();
      service = await buildModule();

      const r = await service.chooseShipping(bidderId, 'order_1', {
        deliveryMethod: 'pickup',
      });

      expect(r).toMatchObject({
        deliveryMethod: 'pickup',
        shippingInCents: 0,
        totalInCents: 6000,
      });
      expect(mockDb.set.mock.calls[0][0].shippingServiceId).toBeNull();
    });

    it('recusa retirada em mãos quando o vendedor não aceita', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([arremate])
        .mockResolvedValueOnce([{ acceptsPickup: false }]);
      stubQuery();
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'pickup',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('recusa escolha de frete de outro comprador', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...arremate, buyerId: 'outro' }]);
      stubQuery();
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 1,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('recusa escolha depois do prazo vencido', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([
        { ...arremate, paymentDeadlineAt: new Date(Date.now() - 1000) },
      ]);
      stubQuery();
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    /**
     * O cron de expiração pode cancelar o pedido entre a leitura e a escrita.
     * Sem esta guarda o front seguia direto para a cobrança de um pedido morto,
     * e o vencedor via "cartão recusado" em vez do motivo real.
     */
    it('avisa quando o prazo vence no meio da escolha (update pega 0 linhas)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      // update().set().where().returning() → nenhuma linha afetada.
      mockDb.set = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      });
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('recusa endereço que não pertence ao comprador', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery({ ...mockEndereco, id: 'addr_9', userId: 'outro_user' });
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 1,
          addressId: 'addr_9',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── payAuctionOrder (Fase 4) ─────────────────────────────────────────────

  describe('payAuctionOrder', () => {
    // Pedido com a entrega JÁ escolhida — é o único estado em que pagar é
    // legal. Lance 6000 + frete 1550: o total é o que vai ao cartão, e a parte
    // da plataforma leva o frete inteiro (660 de comissão + 1550).
    const pendingOrder = {
      id: 'order_1',
      buyerId: bidderId,
      sellerId,
      listingId: mockListingId,
      totalInCents: 7550,
      shippingInCents: 1550,
      shippingServiceId: 1,
      shippingServiceName: 'Correios PAC',
      deliveryMethod: 'shipping',
      sellerNetInCents: 5340,
      platformFeeInCents: 2210,
      status: 'pending_payment',
      paymentDeadlineAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    };
    const paidOrder = {
      id: 'or_paid',
      status: 'paid',
      charges: [{ id: 'ch_paid', status: 'paid' }],
    };

    it('lança NotFound se o pedido não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();
      await expect(service.payAuctionOrder(bidderId, 'nope')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lança Forbidden se o pedido é de outro comprador', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...pendingOrder, buyerId: 'x' }]);
      service = await buildModule();
      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lança BadRequest se o pedido não está pending_payment', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...pendingOrder, status: 'paid' }]);
      service = await buildModule();
      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('lança BadRequest se o prazo de pagamento expirou', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([
        { ...pendingOrder, paymentDeadlineAt: new Date(Date.now() - 1000) },
      ]);
      service = await buildModule();
      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('lança BadRequest se o comprador não tem cartão salvo', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([pendingOrder]);
      mockCardsService.getCardRef.mockReset().mockResolvedValue(null);
      service = await buildModule();
      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('lança BadRequest e NÃO consolida se o cartão é recusado', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([pendingOrder])
        .mockResolvedValueOnce([
          { recipientId: 're_seller', canReceive: true },
        ]); // sellerProfiles → vendedor apto
      mockPagarmeService.post.mockReset().mockResolvedValue({
        id: 'or_x',
        status: 'failed',
        charges: [{ id: 'ch_x', status: 'failed' }],
      });
      service = await buildModule();
      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockWalletService.hold).not.toHaveBeenCalled();
    });

    /**
     * Sem escolha de entrega o total ainda é só o lance. Cobrar aí deixaria a
     * Kolecta pagando a etiqueta — que é exatamente o buraco que este fluxo
     * fecha.
     */
    it('RECUSA pagar enquanto o vencedor não escolheu a entrega', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([
        {
          ...pendingOrder,
          totalInCents: 6000,
          shippingInCents: 0,
          shippingServiceId: null,
          shippingServiceName: null,
          deliveryMethod: 'shipping', // default do schema, não é escolha
        },
      ]);
      service = await buildModule();

      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('aceita pagar quando a escolha foi RETIRADA em mãos (sem serviço de frete)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([
          {
            ...pendingOrder,
            totalInCents: 6000,
            shippingInCents: 0,
            shippingServiceId: null,
            shippingServiceName: null,
            deliveryMethod: 'pickup',
          },
        ])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // _settle
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // void: auction por listingId
        .mockResolvedValueOnce([]); // _getActiveBidAuth: sem auth
      mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
      service = await buildModule();

      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).resolves.toEqual({ orderId: 'order_1', paid: true });
    });

    it('paga com sucesso: cobra lance + frete, retém o líquido e LIBERA a pré-auth', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([pendingOrder]) // order
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // auction por listingId (_settle)
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // auction por listingId (void)
        .mockResolvedValueOnce([{ chargeId: 'ch_bid', orderId: 'or_bid' }]); // pré-auth do lance
      mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
      service = await buildModule();

      const result = await service.payAuctionOrder(bidderId, 'order_1');

      expect(result).toEqual({ orderId: 'order_1', paid: true });
      // Cobrança com captura imediata (capture:true), não pré-auth, e no TOTAL
      // com frete — não no valor do lance.
      expect(mockPagarmeService.post).toHaveBeenCalledWith(
        '/orders',
        expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({ amount: 7550 }),
          ]),
          payments: expect.arrayContaining([
            expect.objectContaining({
              credit_card: expect.objectContaining({ capture: true }),
            }),
          ]),
        }),
        expect.any(String),
      );
      // Líquido do vendedor retido na wallet.
      expect(mockWalletService.hold).toHaveBeenCalled();
      // A retenção do lance cai só DEPOIS da cobrança passar.
      expect(mockPagarmeService.delete).toHaveBeenCalledWith('/charges/ch_bid');
      // Etiqueta só é acionada agora, com o frete pago.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'auction.paid',
        expect.objectContaining({ orderId: 'order_1', shippingInCents: 1550 }),
      );
    });
  });

  // ── expireOverduePendingPayments (Fase 4) ────────────────────────────────

  describe('expireOverduePendingPayments', () => {
    const overdueOrder = {
      id: 'order_ov',
      buyerId: bidderId,
      sellerId,
      listingId: mockListingId,
      totalInCents: 6000,
      status: 'pending_payment',
      paymentDeadlineAt: new Date(Date.now() - 1000),
    };

    // Override de update().set().where() para separar dos selects (que usam
    // mockDb.where): o cancel usa .returning(); os demais updates são awaited.
    const stubUpdatesWithCancel = (cancelResult: any[]) => {
      mockDb.set = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(cancelResult),
        }),
      });
    };

    it('retorna vazio quando não há pedidos vencidos', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // nenhum vencido
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result).toEqual({ expired: [], offered: [], reopened: [] });
    });

    it('REABRE o anúncio quando não há 2º colocado apto', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([overdueOrder]) // vencidos
        .mockResolvedValueOnce([{ id: 'auction_1', reservePriceInCents: null }]) // auction por listingId
        .mockResolvedValueOnce([]); // _getActiveBidAuth: sem pré-auth de pé
      stubUpdatesWithCancel([overdueOrder]); // cancelou o pedido
      // _findRunnerUp: só há lances do próprio vencedor faltoso → sem elegível.
      mockDb.orderBy.mockResolvedValue([
        { bidId: 'b1', bidderId, amountInCents: 6000, status: 'lost' },
      ]);
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result.expired).toContain('order_ov');
      expect(result.reopened).toContain('order_ov');
      expect(result.offered).toEqual([]);
    });

    /**
     * Virou obrigatório quando o fecho parou de capturar: todo arremate nasce
     * com uma pré-auth VIVA segurando o cartão. Quem desiste não pode ficar com
     * o limite preso até a adquirente expirar sozinha (~5 dias).
     */
    it('LIBERA a retenção do cartão do faltoso ao expirar o prazo', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([overdueOrder])
        .mockResolvedValueOnce([{ id: 'auction_1', reservePriceInCents: null }])
        .mockResolvedValueOnce([
          { chargeId: 'ch_faltoso', orderId: 'or_faltoso' },
        ]); // pré-auth de pé
      stubUpdatesWithCancel([overdueOrder]);
      mockDb.orderBy.mockResolvedValue([
        { bidId: 'b1', bidderId, amountInCents: 6000, status: 'lost' },
      ]);
      service = await buildModule();

      await service.expireOverduePendingPayments();

      expect(mockPagarmeService.delete).toHaveBeenCalledWith(
        '/charges/ch_faltoso',
      );
    });

    it('OFERECE ao 2º colocado quando existe lance elegível acima da reserva', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([overdueOrder]) // vencidos
        .mockResolvedValueOnce([{ id: 'auction_1', reservePriceInCents: 3000 }]) // auction
        .mockResolvedValueOnce([]) // _getActiveBidAuth: sem pré-auth de pé
        // _findRunnerUp segue a cadeia até orderBy — precisa do chain, não de
        // um array; só depois dele vêm o endereço e o título do anúncio.
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: 'end_2', isDefault: true }]) // endereço do 2º
        .mockResolvedValueOnce([{ title: 'Item de teste' }]); // título p/ o e-mail
      stubUpdatesWithCancel([overdueOrder]);
      // Vencedor faltoso (buyer_001) + 2º colocado (buyer_002) com lance válido.
      mockDb.orderBy.mockResolvedValue([
        { bidId: 'b1', bidderId, amountInCents: 6000, status: 'lost' },
        {
          bidId: 'b2',
          bidderId: 'buyer_002',
          amountInCents: 5000,
          status: 'outbid',
        },
      ]);
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result.expired).toContain('order_ov');
      expect(result.offered).toContain('order_ov');
      expect(result.reopened).toEqual([]);
      // O promovido tem prazo correndo e precisa escolher o frete — antes era
      // promovido no silêncio, o que garantia que o prazo vencesse de novo.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'auction.won',
        expect.objectContaining({
          winnerId: 'buyer_002',
          needsShippingChoice: true,
        }),
      );
    });

    it('não conta como expirado se o cancelamento perde a corrida (já pago)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([overdueOrder]); // vencidos
      stubUpdatesWithCancel([]); // cancel não afetou linhas → noop
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result.expired).toEqual([]);
    });
  });
});

/**
 * Reenvio do aviso de arremate.
 *
 * O aviso sai UMA vez, no fecho, e não havia como repeti-lo. Quando ele se
 * perde, o vencedor nunca fica sabendo — e o prazo corre igual: vencido, a
 * pré-auth é liberada e a peça vai para o 2º colocado. Em 11/08/2026 dois
 * arremates (R$ 460) ficaram nessa situação porque o cadastro do comprador
 * tinha e-mail placeholder, e não existia socorro nenhum.
 */
describe('AuctionsService — reenviar aviso de arremate', () => {
  const PEDIDO = {
    id: 'ord-1',
    buyerId: 'user_bidder',
    listingId: 'lst-1',
    status: 'pending_payment',
    totalInCents: 26000,
    shippingInCents: 0,
    shippingServiceId: null,
    deliveryMethod: 'shipping',
    paymentDeadlineAt: new Date(Date.now() + 45 * 3_600_000),
  };

  function montar(over: any = {}) {
    const emitter = { emit: jest.fn() };
    const db: any = {
      query: {
        orders: {
          findFirst: jest.fn().mockResolvedValue(over.order ?? PEDIDO),
        },
        auctions: {
          findFirst: jest
            .fn()
            .mockResolvedValue(
              'auction' in over ? over.auction : { id: 'auc-1' },
            ),
        },
        listings: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ title: 'Hot Wheels Sam Walton' }),
        },
        users: {
          findFirst: jest
            .fn()
            .mockResolvedValue(
              'user' in over
                ? over.user
                : { id: 'user_bidder', email: 'billy@real.com.br' },
            ),
        },
      },
    };
    const service = new AuctionsService(
      db,
      mockWalletService as any,
      mockFounderService as any,
      mockCardsService as any,
      mockPagarmeService as any,
      mockShippingService as any,
      emitter as any,
    );
    return { service, emitter };
  }

  it('reemite auction.won com o prazo que REALMENTE sobra', async () => {
    const { service, emitter } = montar();

    const r = await service.reenviarAvisoDeArremate('ord-1');

    expect(emitter.emit).toHaveBeenCalledWith(
      'auction.won',
      expect.objectContaining({
        orderId: 'ord-1',
        winnerId: 'user_bidder',
        needsPayment: true,
        needsShippingChoice: true,
        finalAmountInCents: 26000,
      }),
    );
    // 45h restantes, não as 48h originais: o e-mail chega depois, e repetir o
    // prazo cheio faria o vencedor se planejar pelo número errado.
    const payload = emitter.emit.mock.calls[0][1] as any;
    expect(payload.paymentDeadlineHours).toBe(44);
    expect(r.destinatario).toBe('billy@real.com.br');
  });

  it('não pede escolha de frete a quem já escolheu', async () => {
    const { service, emitter } = montar({
      order: {
        ...PEDIDO,
        shippingServiceId: 1,
        shippingInCents: 2274,
        totalInCents: 28274,
      },
    });

    await service.reenviarAvisoDeArremate('ord-1');

    const payload = emitter.emit.mock.calls[0][1] as any;
    expect(payload.needsShippingChoice).toBe(false);
    // O valor anunciado é o da PEÇA: somar o frete mostraria um total que o
    // vencedor não reconheceria do leilão.
    expect(payload.finalAmountInCents).toBe(26000);
  });

  /**
   * Reenviar para um cadastro quebrado repetiria o problema original em
   * silêncio. Melhor recusar e mandar consertar o cadastro primeiro.
   */
  it('recusa quando o vencedor não tem e-mail', async () => {
    const { service, emitter } = montar({
      user: { id: 'user_bidder', email: null },
    });

    await expect(service.reenviarAvisoDeArremate('ord-1')).rejects.toThrow(
      /e-mail/i,
    );
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('recusa pedido que não está aguardando pagamento', async () => {
    const { service, emitter } = montar({
      order: { ...PEDIDO, status: 'paid' },
    });

    await expect(service.reenviarAvisoDeArremate('ord-1')).rejects.toThrow(
      /pending_payment/,
    );
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('recusa pedido que não veio de leilão', async () => {
    const { service, emitter } = montar({ auction: null });

    await expect(service.reenviarAvisoDeArremate('ord-1')).rejects.toThrow(
      /não veio de leilão/i,
    );
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
