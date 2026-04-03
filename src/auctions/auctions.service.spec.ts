import { Test, TestingModule } from '@nestjs/testing';
import { AuctionsService } from './auctions.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

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
const makeDrizzleMock = () => {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue([mockAuction]);
  chain.orderBy = jest.fn().mockResolvedValue([mockBid]);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue([mockAuction]);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.set = jest.fn().mockReturnValue(chain);
  chain.transaction = jest.fn().mockImplementation(async (fn: any) => {
    const tx: any = {};
    tx.insert = jest.fn().mockReturnValue(tx);
    tx.values = jest.fn().mockReturnValue(tx);
    tx.returning = jest.fn().mockResolvedValue([mockBid]);
    tx.update = jest.fn().mockReturnValue(tx);
    tx.set = jest.fn().mockReturnValue(tx);
    tx.where = jest.fn().mockResolvedValue(undefined);
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
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }]); // listing different seller
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
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }]);
      service = await buildModule();

      const result = await service.placeBid(mockAuctionId, bidderId, {
        amountInCents: 6100, // > 5000 + 1000
      });

      expect(result).toEqual(mockBid);
    });
  });
});
