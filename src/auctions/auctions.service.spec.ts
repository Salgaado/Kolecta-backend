import { Test, TestingModule } from '@nestjs/testing';
import { AuctionsService } from './auctions.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { WalletService } from '../wallet/wallet.service';
import { FounderService } from '../founder/founder.service';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';

const mockWalletService = {
  creditSeller: jest.fn(),
  holdBalance: jest.fn(),
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
        {
          provide: FounderService,
          useValue: { resolveCommissionPercent: jest.fn().mockResolvedValue(11) },
        },
      ],
    }).compile();

    return module.get<AuctionsService>(AuctionsService);
  };

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

    it('deve registrar lance com sucesso', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([
          { ...mockListing, sellerId: 'another_seller' },
        ]);
      service = await buildModule();

      const result = await service.placeBid(mockAuctionId, bidderId, {
        amountInCents: 6100, // > 5000 + 1000
      });

      expect(result).toEqual(mockBid);
    });

    it('deve lançar ConflictException se outro lance vencer a corrida (update-guard)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }]);

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

    it('deve encerrar o leilão quando o requester é o seller', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])                   // auction ativo
        .mockResolvedValueOnce([mockListing])                   // listing pertence ao seller
        .mockResolvedValueOnce([{ id: sellerId, role: 'user' }]); // requester é o seller
      service = await buildModule();

      // _closeAuction usa transaction — mockDb.transaction já está configurado
      await expect(
        service.endAuction(mockAuctionId, sellerId),
      ).resolves.not.toThrow();

      expect(mockDb.transaction).toHaveBeenCalled();
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

      expect(mockDb.transaction).toHaveBeenCalled();
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

      // Faz a transaction falhar apenas na primeira chamada
      let txCallCount = 0;
      mockDb.transaction = jest.fn().mockImplementation(async (fn: any) => {
        txCallCount++;
        if (txCallCount === 1) throw new Error('Falha simulada');
        const tx: any = {};
        tx.update = jest.fn().mockReturnValue(tx);
        tx.set = jest.fn().mockReturnValue(tx);
        tx.where = jest.fn().mockResolvedValue(undefined);
        tx.insert = jest.fn().mockReturnValue(tx);
        tx.values = jest.fn().mockReturnValue(tx);
        tx.returning = jest.fn().mockResolvedValue([]);
        return fn(tx);
      });

      service = await buildModule();

      const result = await service.endExpiredAuctions();

      // Só o segundo deve ter sido fechado com sucesso
      expect(result).toContain('auction_exp_2');
      expect(result).not.toContain('auction_exp_1');
    });
  });
});
