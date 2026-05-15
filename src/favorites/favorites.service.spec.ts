import { FavoritesService } from './favorites.service';
import { NotFoundException } from '@nestjs/common';

const mockUserId = 'user_test_123';
const mockListingId = 'listing_test_789';

const mockListing = {
  id: mockListingId,
  status: 'aprovado',
  sellerId: 'seller_x',
};
const mockFavorite = {
  id: 'fav_001',
  userId: mockUserId,
  listingId: mockListingId,
  createdAt: new Date(),
};

describe('FavoritesService', () => {
  let service: FavoritesService;

  const makeMockDb = (results: any = [mockFavorite]) => {
    const chain: any = {
      results,
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      then: jest.fn().mockImplementation(function (resolve: (value: any) => void) {
        return Promise.resolve(this.results).then(resolve);
      }),
    };
    return chain;
  };

  describe('findAll', () => {
    it('deve retornar lista de favoritos do usuário', async () => {
      const mockDb = makeMockDb([mockFavorite]);
      service = new FavoritesService(mockDb as any);

      const result = await service.findAll(mockUserId);
      expect(result).toEqual([mockFavorite]);
    });
  });

  describe('toggle', () => {
    it('deve lançar NotFoundException se listing não existe', async () => {
      const mockDb = makeMockDb([]); // listing empty
      service = new FavoritesService(mockDb as any);

      await expect(service.toggle(mockUserId, mockListingId)).rejects.toThrow(NotFoundException);
    });

    it('deve remover favorito (toggle OFF) se já existir', async () => {
      const mockDb = makeMockDb();
      let calls = 0;
      mockDb.then.mockImplementation(function (resolve: (value: any) => void) {
        calls++;
        const res = calls === 1 ? [mockListing] : (calls === 2 ? [mockFavorite] : undefined);
        return Promise.resolve(res).then(resolve);
      });
      service = new FavoritesService(mockDb as any);

      const result = await service.toggle(mockUserId, mockListingId);
      expect(result).toEqual({ favorited: false });
    });

    it('deve adicionar favorito (toggle ON) se não existir', async () => {
      const mockDb = makeMockDb();
      let calls = 0;
      mockDb.then.mockImplementation(function (resolve: (value: any) => void) {
        calls++;
        const res = calls === 1 ? [mockListing] : (calls === 2 ? [] : [mockFavorite]);
        return Promise.resolve(res).then(resolve);
      });
      service = new FavoritesService(mockDb as any);

      const result = await service.toggle(mockUserId, mockListingId);
      expect(result).toEqual({ favorited: true, data: mockFavorite });
    });
  });

  describe('remove', () => {
    it('deve lançar NotFoundException se favorito não existe', async () => {
      const mockDb = makeMockDb([]);
      service = new FavoritesService(mockDb as any);

      await expect(service.remove(mockUserId, mockListingId)).rejects.toThrow(NotFoundException);
    });

    it('deve remover favorito com sucesso', async () => {
      const mockDb = makeMockDb();
      let calls = 0;
      mockDb.then.mockImplementation(function (resolve: (value: any) => void) {
        calls++;
        const res = calls === 1 ? [mockFavorite] : undefined;
        return Promise.resolve(res).then(resolve);
      });
      service = new FavoritesService(mockDb as any);

      await expect(service.remove(mockUserId, mockListingId)).resolves.not.toThrow();
    });
  });
});
