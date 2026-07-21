import { Test, TestingModule } from '@nestjs/testing';
import { ListingsService } from './listings.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { FounderService } from '../founder/founder.service';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
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
  leftJoin: jest.fn().mockReturnThis(),
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

// Transação (create): registra em qual tabela cada insert foi feito.
const txInsert = jest.fn(() => insertChain);
const mockTx = { insert: txInsert };

const mockDb = {
  select: () => selectChain,
  update: () => updateChain,
  delete: () => deleteChain,
  insert: () => insertChain,
  transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
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
        {
          provide: FounderService,
          useValue: { evaluate: jest.fn().mockResolvedValue(undefined) },
        },
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
      await expect(service.findById('nao_existe')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── create ─────────────────────────────────────────────────────────────────
  describe('create', () => {
    afterEach(() => {
      delete process.env.ENFORCE_SELLER_KYC;
    });

    const dto = {
      title: 'Hot Wheels RLC Skyline',
      condition: 'lacrado',
      type: 'direct' as const,
      priceInCents: 50000,
    };

    it('deve inserir e retornar o novo listing (gate OFF por padrão)', async () => {
      selectChain.limit
        .mockResolvedValueOnce([{ id: 'addr_1' }]) // assertHasOriginAddress
        .mockResolvedValueOnce([fakeListing]); // findById pós-insert

      const result = await service.create('user_seller', dto);

      expect(insertChain.values).toHaveBeenCalled();
      expect(result).toEqual(fakeListing);
    });

    it('sem endereço de origem cadastrado → BadRequestException', async () => {
      selectChain.limit.mockResolvedValueOnce([]); // nenhum endereço

      await expect(service.create('user_seller', dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(insertChain.values).not.toHaveBeenCalled();
    });

    it('com ENFORCE_SELLER_KYC=true e canReceive=false → ForbiddenException', async () => {
      process.env.ENFORCE_SELLER_KYC = 'true';
      selectChain.limit.mockResolvedValueOnce([{ canReceive: false }]);

      await expect(service.create('user_seller', dto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(insertChain.values).not.toHaveBeenCalled();
    });

    it('com ENFORCE_SELLER_KYC=true e canReceive=true → cria normalmente', async () => {
      process.env.ENFORCE_SELLER_KYC = 'true';
      selectChain.limit
        .mockResolvedValueOnce([{ canReceive: true }]) // assertCanSell
        .mockResolvedValueOnce([{ id: 'addr_1' }]) // assertHasOriginAddress
        .mockResolvedValueOnce([fakeListing]); // findById pós-insert

      const result = await service.create('user_seller', dto);

      expect(insertChain.values).toHaveBeenCalled();
      expect(result).toEqual(fakeListing);
    });

    it('type=auction cria o listing E a linha de auction (relógio parado)', async () => {
      selectChain.limit
        .mockResolvedValueOnce([{ id: 'addr_1' }]) // assertHasOriginAddress
        .mockResolvedValueOnce([{ ...fakeListing, type: 'auction' }]); // findById

      await service.create('user_seller', {
        title: 'Leilão X',
        condition: 'lacrado',
        type: 'auction',
        startingBidInCents: 100000,
        durationHours: 72,
      });

      const insertedTables = txInsert.mock.calls.map((c: any[]) => c[0]);
      expect(insertedTables).toContain(schema.listings);
      expect(insertedTables).toContain(schema.auctions);
    });

    it('type=auction sem startingBidInCents → BadRequestException', async () => {
      selectChain.limit.mockResolvedValueOnce([{ id: 'addr_1' }]); // passa o gate de endereço

      await expect(
        service.create('user_seller', {
          title: 'Leilão sem lance',
          condition: 'lacrado',
          type: 'auction',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('deve atualizar quando o sellerId bate', async () => {
      // findById (antes do update) + findById (pós update)
      selectChain.limit
        .mockResolvedValueOnce([fakeListing])
        .mockResolvedValueOnce([{ ...fakeListing, title: 'Novo Título' }]);

      const result = await service.update('listing_001', 'user_seller', {
        title: 'Novo Título',
      });

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

      await expect(service.remove('listing_001', 'user_outro')).rejects.toThrow(
        ForbiddenException,
      );
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

    it('ao ativar um anúncio de leilão, inicia o relógio (endsAt)', async () => {
      const auctionListing = { ...fakeListing, type: 'auction' };
      selectChain.limit
        .mockResolvedValueOnce([auctionListing]) // findById inicial
        .mockResolvedValueOnce([{ id: 'auc_1', endsAt: null, durationHours: 48 }]) // busca auction
        .mockResolvedValueOnce([auctionListing]); // findById final

      await service.updateStatus('listing_001', 'active');

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ endsAt: expect.any(Date) }),
      );
    });
  });
});
