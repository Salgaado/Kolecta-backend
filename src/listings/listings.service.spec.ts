import { Test, TestingModule } from '@nestjs/testing';
import { ListingsService } from './listings.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import * as schema from '../database/schema';

// ─── Mock DB ──────────────────────────────────────────────────────────────────

const fakeListing = {
  id: 'listing_001',
  sellerId: 'user_seller',
  categoryId: null,
  title: 'Hot Wheels RLC Skyline',
  description: 'Item raro',
  brand: 'Hot Wheels',
  line: 'RLC',
  scale: '1:64',
  year: '2023',
  edition: 'Limited',
  condition: 'lacrado',
  type: 'direct',
  priceInCents: 50000,
  images: null,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const selectChain = {
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn(),
  offset: jest.fn(),
};

const updateChain = {
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue(undefined),
};

const deleteChain = {
  where: jest.fn().mockResolvedValue(undefined),
};

const insertChain = {
  values: jest.fn().mockResolvedValue(undefined),
};

const mockDb = {
  select: () => selectChain,
  update: () => updateChain,
  delete: () => deleteChain,
  insert: () => insertChain,
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('ListingsService', () => {
  let service: ListingsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
      ],
    }).compile();

    service = module.get<ListingsService>(ListingsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── findById ───────────────────────────────────────────────────────────────
  describe('findById', () => {
    it('deve retornar o listing quando encontrado', async () => {
      selectChain.limit.mockResolvedValueOnce([fakeListing]);
      const result = await service.findById('listing_001');
      expect(result).toEqual(fakeListing);
    });

    it('deve lançar NotFoundException quando não encontrado', async () => {
      selectChain.limit.mockResolvedValueOnce([]);
      await expect(service.findById('nao_existe')).rejects.toThrow(NotFoundException);
    });
  });

  // ── create ─────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('deve inserir e retornar o novo listing', async () => {
      selectChain.limit.mockResolvedValueOnce([fakeListing]);

      const result = await service.create('user_seller', {
        title: 'Hot Wheels RLC Skyline',
        condition: 'lacrado',
        type: 'direct',
        priceInCents: 50000,
      });

      expect(insertChain.values).toHaveBeenCalled();
      expect(result).toEqual(fakeListing);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('deve atualizar quando o sellerId bate', async () => {
      // findById (antes do update) + findById (pós update)
      selectChain.limit
        .mockResolvedValueOnce([fakeListing])
        .mockResolvedValueOnce([{ ...fakeListing, title: 'Novo Título' }]);

      const result = await service.update('listing_001', 'user_seller', { title: 'Novo Título' });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Novo Título' }),
      );
      expect(result.title).toBe('Novo Título');
    });

    it('deve lançar ForbiddenException se sellerId não bate', async () => {
      selectChain.limit.mockResolvedValueOnce([fakeListing]);

      await expect(
        service.update('listing_001', 'user_outro', { title: 'X' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── remove ─────────────────────────────────────────────────────────────────
  describe('remove', () => {
    it('deve deletar quando o sellerId bate', async () => {
      selectChain.limit.mockResolvedValueOnce([fakeListing]);
      await service.remove('listing_001', 'user_seller');
      expect(deleteChain.where).toHaveBeenCalled();
    });

    it('deve lançar ForbiddenException se sellerId não bate', async () => {
      selectChain.limit.mockResolvedValueOnce([fakeListing]);

      await expect(
        service.remove('listing_001', 'user_outro'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── updateStatus ───────────────────────────────────────────────────────────
  describe('updateStatus', () => {
    it('deve atualizar o status (admin)', async () => {
      selectChain.limit
        .mockResolvedValueOnce([fakeListing])
        .mockResolvedValueOnce([{ ...fakeListing, status: 'active' }]);

      const result = await service.updateStatus('listing_001', 'active');

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' }),
      );
    });
  });
});
