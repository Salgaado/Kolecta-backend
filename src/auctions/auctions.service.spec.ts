import { Test, TestingModule } from '@nestjs/testing';
import { AuctionsService } from './auctions.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { WalletService } from '../wallet/wallet.service';
import { FounderService } from '../founder/founder.service';
import { CardsService } from '../cards/cards.service';
import { PagarmeService } from '../pagarme/pagarme.service';
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
    return fn(tx);
  });
  return chain;
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
        .mockResolvedValueOnce([]); // sellerProfiles → sem recebedor (sem split)
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
        .mockResolvedValueOnce([]); // sellerProfiles → sem recebedor
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
        .mockResolvedValueOnce([]); // sellerProfiles

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
        .mockResolvedValueOnce([{ chargeId: 'ch_1', orderId: 'or_1' }]); // _getActiveBidAuth
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
        .mockResolvedValueOnce([{ chargeId: 'ch_1', orderId: 'or_1' }]);
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
});
