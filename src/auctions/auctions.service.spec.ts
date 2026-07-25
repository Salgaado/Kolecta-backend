/**
 * O cartão está FECHADO por padrão (`payment-flags.ts`) enquanto o antifraude
 * da Pagar.me reprova toda cobrança. Estes testes cobrem o cartão funcionando,
 * então ligam o interruptor antes do import — a flag é lida no carregamento do
 * módulo.
 */
process.env.PAGAMENTO_CARTAO_HABILITADO = 'true';

import { Test, TestingModule } from '@nestjs/testing';
import { AuctionsService } from './auctions.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { WalletService } from '../wallet/wallet.service';
import { FounderService } from '../founder/founder.service';
import { CardsService } from '../cards/cards.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Emissor de eventos: só precisamos observar o que foi emitido.
const mockEventEmitter = { emit: jest.fn() };
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

// Pré-auth padrão: order com charge autorizada (pending → authorized_pending_capture).
const authorizedOrder = {
  id: 'or_1',
  status: 'pending',
  charges: [{ id: 'ch_1', status: 'authorized_pending_capture' }],
};

const mockPagarmeService = {
  post: jest.fn().mockResolvedValue(authorizedOrder),
  delete: jest.fn().mockResolvedValue({}),
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
  chain.where = jest.fn().mockReturnValue(chain);  // retorna chain por padrão
  chain.innerJoin = jest.fn().mockReturnValue(chain);
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
  id: 'addr_1', userId: 'user_bidder', street: 'Rua Teste', number: '100',
  complement: null, neighborhood: 'Centro', city: 'Sao Paulo', state: 'SP',
  zip: '01310-100', country: 'BR', isDefault: true,
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
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    return module.get<AuctionsService>(AuctionsService);
  };

  beforeEach(() => {
    // Restaura defaults dos mocks compartilhados (evita vazamento de *Once).
    mockWalletService.getOrCreateWallet.mockReset().mockResolvedValue(mockWallet);
    mockWalletService.hold.mockReset().mockResolvedValue({ success: true });
    mockFounderService.resolveCommissionPercent.mockReset().mockResolvedValue(11);
    mockCardsService.getCardRef
      .mockReset()
      .mockResolvedValue({ customerId: 'cus_1', cardId: 'card_1' });
    mockPagarmeService.post.mockReset().mockResolvedValue(authorizedOrder);
    mockPagarmeService.delete.mockReset().mockResolvedValue({});
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
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }]);
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
        .mockResolvedValueOnce([]) // sellerProfiles → sem recebedor (sem split)
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
        .mockResolvedValueOnce([]) // sellerProfiles → sem recebedor
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
        .mockResolvedValueOnce([]) // sellerProfiles
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
      await expect(
        chamar([{ id: 'end_a', isDefault: false }]),
      ).resolves.toBe('end_a');
    });

    it('devolve null quando o usuário não tem endereço', async () => {
      await expect(chamar([])).resolves.toBeNull();
    });
  });

  describe('endAuction', () => {
    it('deve lançar NotFoundException se leilão não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([]); // auction não encontrado
      service = await buildModule();

      await expect(
        service.endAuction('auction_nope', sellerId),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar BadRequestException se leilão não está ativo', async () => {
      const endedAuction = { ...mockAuction, status: 'ended' };
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([endedAuction]);
      service = await buildModule();

      await expect(
        service.endAuction(mockAuctionId, sellerId),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar ForbiddenException se requester não é seller nem admin', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])                          // auction ativo
        .mockResolvedValueOnce([mockListing])                          // listing com sellerId diferente
        .mockResolvedValueOnce([{ id: 'outro_user', role: 'user' }]); // requester não é admin
      service = await buildModule();

      await expect(
        service.endAuction(mockAuctionId, 'outro_user'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deve encerrar o leilão quando o requester é o seller (sem vencedor)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])                   // auction ativo (sem vencedor)
        .mockResolvedValueOnce([mockListing])                   // listing pertence ao seller
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
        .mockResolvedValueOnce([mockAuction])                          // auction ativo
        .mockResolvedValueOnce([mockListing])                          // listing (seller diferente)
        .mockResolvedValueOnce([{ id: 'admin_user', role: 'admin' }]); // requester é admin
      service = await buildModule();

      await expect(
        service.endAuction(mockAuctionId, 'admin_user'),
      ).resolves.not.toThrow();

      expect(mockDb.update).toHaveBeenCalled();
    });

    it('deve CAPTURAR a pré-auth do vencedor e reter o líquido do vendedor', async () => {
      const winnerAuction = {
        ...mockAuction,
        currentWinnerId: bidderId,
        currentBidInCents: 6000,
      };
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([winnerAuction])                  // auction (com vencedor)
        .mockResolvedValueOnce([mockListing])                    // listing
        .mockResolvedValueOnce([{ id: sellerId, role: 'user' }]) // requester = seller
        .mockResolvedValueOnce([{ chargeId: 'ch_1', orderId: 'or_1' }]) // _getActiveBidAuth
        .mockResolvedValueOnce([{ id: 'end_1', isDefault: true }]); // endereço do vencedor
      // Captura da pré-auth confirmada.
      mockPagarmeService.post.mockReset().mockResolvedValue({ status: 'paid' });
      service = await buildModule();

      await service.endAuction(mockAuctionId, sellerId);

      // Capturou a charge autorizada.
      expect(mockPagarmeService.post).toHaveBeenCalledWith(
        '/charges/ch_1/capture',
        { amount: 6000 },
        expect.any(String),
      );
      // Espelhou o líquido do vendedor como retido na wallet.
      expect(mockWalletService.hold).toHaveBeenCalled();
      // O pedido nasce COM endereço: sem ele a etiqueta do Melhor Envio nem
      // chega a ser pedida, e o leilão não tem checkout para escolher um.
      const pedido = mockDb.txs
        .flatMap((tx: any) => tx.values.mock.calls)
        .map((c: any[]) => c[0])
        .find((v: any) => v?.buyerId === bidderId);
      expect(pedido?.addressId).toBe('end_1');
    });

    it('deve deixar o pedido pending_payment se a captura falhar (Fase 4)', async () => {
      const winnerAuction = {
        ...mockAuction,
        currentWinnerId: bidderId,
        currentBidInCents: 6000,
      };
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([winnerAuction])
        .mockResolvedValueOnce([mockListing])
        .mockResolvedValueOnce([{ id: sellerId, role: 'user' }])
        .mockResolvedValueOnce([{ chargeId: 'ch_1', orderId: 'or_1' }])
        .mockResolvedValueOnce([{ id: 'end_1', isDefault: true }]); // endereço do vencedor
      // Captura NÃO confirmada → _captureCharge lança → ramo pending_payment.
      mockPagarmeService.post.mockReset().mockResolvedValue({ status: 'failed' });
      service = await buildModule();

      await service.endAuction(mockAuctionId, sellerId);

      // Sem captura confirmada, o líquido do vendedor NÃO é retido.
      expect(mockWalletService.hold).not.toHaveBeenCalled();
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
        .mockResolvedValueOnce([expiredAuction])  // leilões expirados
        .mockResolvedValueOnce([mockListing]);      // listing do leilão expirado
      service = await buildModule();

      const result = await service.endExpiredAuctions();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toContain('auction_expired');
    });

    it('deve continuar processando mesmo se um leilão falhar', async () => {
      const expiredAuction1 = { ...mockAuction, id: 'auction_exp_1', endsAt: new Date(Date.now() - 1000) };
      const expiredAuction2 = { ...mockAuction, id: 'auction_exp_2', endsAt: new Date(Date.now() - 2000) };
      mockDb = makeDrizzleMock();
      // Retorna 2 expirados
      mockDb.where
        .mockResolvedValueOnce([expiredAuction1, expiredAuction2])
        .mockResolvedValueOnce([mockListing])  // listing para o primeiro
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

  // ── reauthorizeExpiringBids (Fase 3) ─────────────────────────────────────

  describe('reauthorizeExpiringBids', () => {
    const reauthRow = {
      bidId: 'bid_001',
      auctionId: mockAuctionId,
      bidderId,
      amountInCents: 6000,
      chargeId: 'ch_old',
      sellerId,
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
        .mockResolvedValueOnce([]) // sellerProfiles → sem recebedor (sem split)
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
        .mockResolvedValueOnce([]) // sellerProfiles
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
        .mockResolvedValueOnce([]) // sellerProfiles
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
  });

  // ── payAuctionOrder (Fase 4) ─────────────────────────────────────────────

  describe('payAuctionOrder', () => {
    const pendingOrder = {
      id: 'order_1',
      buyerId: bidderId,
      sellerId,
      listingId: mockListingId,
      totalInCents: 6000,
      sellerNetInCents: 5340,
      platformFeeInCents: 660,
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
        .mockResolvedValueOnce([]); // sellerProfiles (sem split)
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

    it('paga com sucesso: cobra o cartão (à vista) e retém o líquido do vendedor', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([pendingOrder]) // order
        .mockResolvedValueOnce([]) // sellerProfiles (sem split)
        .mockResolvedValueOnce([{ id: 'auction_1' }]); // auction por listingId (_settle)
      mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
      service = await buildModule();

      const result = await service.payAuctionOrder(bidderId, 'order_1');

      expect(result).toEqual({ orderId: 'order_1', paid: true });
      // Cobrança com captura imediata (capture:true), não pré-auth.
      expect(mockPagarmeService.post).toHaveBeenCalledWith(
        '/orders',
        expect.objectContaining({
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
        .mockResolvedValueOnce([
          { id: 'auction_1', reservePriceInCents: null },
        ]); // auction por listingId
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

    it('OFERECE ao 2º colocado quando existe lance elegível acima da reserva', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([overdueOrder]) // vencidos
        .mockResolvedValueOnce([
          { id: 'auction_1', reservePriceInCents: 3000 },
        ]) // auction
        // _findRunnerUp segue a cadeia até orderBy — precisa do chain, não de
        // um array; só depois dele vem a consulta do endereço.
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: 'end_2', isDefault: true }]); // endereço do 2º
      stubUpdatesWithCancel([overdueOrder]);
      // Vencedor faltoso (buyer_001) + 2º colocado (buyer_002) com lance válido.
      mockDb.orderBy.mockResolvedValue([
        { bidId: 'b1', bidderId, amountInCents: 6000, status: 'lost' },
        { bidId: 'b2', bidderId: 'buyer_002', amountInCents: 5000, status: 'outbid' },
      ]);
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result.expired).toContain('order_ov');
      expect(result.offered).toContain('order_ov');
      expect(result.reopened).toEqual([]);
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
