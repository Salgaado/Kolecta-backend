import { Test, TestingModule } from '@nestjs/testing';
import { FavoritesService } from './favorites.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { NotFoundException } from '@nestjs/common';

const mockUserId = 'user_test_123';
const mockListingId = 'listing_test_789';

const mockListing = { id: mockListingId, status: 'active', sellerId: 'seller_x' };
const mockFavorite = {
  id: 'fav_001',
  userId: mockUserId,
  listingId: mockListingId,
  createdAt: new Date(),
};

// Builder de mock Drizzle com encadeamento completo
const makeDrizzleMock = () => {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue([mockFavorite]);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue([mockFavorite]);
  chain.delete = jest.fn().mockReturnValue(chain);
  return chain;
};

describe('FavoritesService', () => {
  let service: FavoritesService;
  let mockDb: any;

  const buildModule = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FavoritesService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
      ],
    }).compile();

    return module.get<FavoritesService>(FavoritesService);
  };

  // ── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('deve retornar lista de favoritos do usuário', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([mockFavorite]);
      service = await buildModule();

      const result = await service.findAll(mockUserId);
      expect(result).toEqual([mockFavorite]);
    });
  });

  // ── toggle ───────────────────────────────────────────────────────────────

  describe('toggle', () => {
    it('deve lançar NotFoundException se listing não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // listing not found
      service = await buildModule();

      await expect(
        service.toggle(mockUserId, 'listing_inexistente'),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve remover favorito (toggle OFF) se já existir', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockListing])  // listing found
        .mockResolvedValueOnce([mockFavorite]) // already favorited
        .mockResolvedValueOnce(undefined);     // delete
      service = await buildModule();

      const result = await service.toggle(mockUserId, mockListingId);
      expect(result).toEqual({ favorited: false });
    });

    it('deve adicionar favorito (toggle ON) se não existir', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockListing]) // listing found
        .mockResolvedValueOnce([]);           // not yet favorited
      mockDb.returning.mockResolvedValueOnce([mockFavorite]);
      service = await buildModule();

      const result = await service.toggle(mockUserId, mockListingId);
      expect(result).toEqual({ favorited: true, data: mockFavorite });
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('deve lançar NotFoundException se favorito não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();

      await expect(
        service.remove(mockUserId, mockListingId),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve remover favorito com sucesso', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockFavorite]) // find
        .mockResolvedValueOnce(undefined);     // delete
      service = await buildModule();

      await expect(
        service.remove(mockUserId, mockListingId),
      ).resolves.not.toThrow();
    });
  });
});
