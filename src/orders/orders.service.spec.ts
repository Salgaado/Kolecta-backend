import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { WalletService } from '../wallet/wallet.service';
import { StripeService } from '../stripe/stripe.service';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';

// ─── Mock DB ──────────────────────────────────────────────────────────────────

const fakeListingActive = {
  id: 'listing_001',
  sellerId: 'user_seller',
  title: 'Hot Wheels',
  status: 'active',
  priceInCents: 50000,
};

const fakeListingSold = {
  id: 'listing_002',
  sellerId: 'user_seller_2',
  title: 'Matchbox',
  status: 'sold',
  priceInCents: 10000,
};

const fakeListingOwn = {
  id: 'listing_003',
  sellerId: 'user_buyer', // mesmo dono do buyer
  title: 'Meu Produto',
  status: 'active',
  priceInCents: 5000,
};

const selectChain = {
  from: jest.fn().mockReturnThis(),
  where: jest.fn(),
};

const updateChain = {
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue(undefined),
};

const insertChain = {
  values: jest.fn().mockReturnThis(),
  returning: jest
    .fn()
    .mockResolvedValue([{ id: 'order_123', status: 'pending' }]),
};

const mockTx = {
  update: () => updateChain,
  insert: () => insertChain,
};

const mockDb = {
  select: () => selectChain,
  update: () => updateChain,
  insert: () => insertChain,
  transaction: jest.fn(async (cb) => cb(mockTx)),
};

// Mock do WalletService — hold é chamado no handleCheckoutCompleted
const mockWalletService = {
  hold: jest.fn().mockResolvedValue({ success: true }),
  getOrCreateWallet: jest
    .fn()
    .mockResolvedValue({ id: 'wallet_001', balanceInCents: 0 }),
};

const mockStripeService = {
  stripe: {
    paymentIntents: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'pi_test', client_secret: 'cs_test' }),
    },
  },
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('OrdersService', () => {
  let service: OrdersService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
        { provide: WalletService, useValue: mockWalletService },
        { provide: StripeService, useValue: mockStripeService },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  describe('createOrders', () => {
    it('deve lançar BadRequestException se o carrinho for vazio', async () => {
      await expect(
        service.createOrders('user_buyer', { items: [] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar NotFoundException se itens solicitados nao existirem', async () => {
      selectChain.where.mockResolvedValueOnce([]); // banco não acha nada
      await expect(
        service.createOrders('user_buyer', {
          items: [{ listingId: 'fake_123' }],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar BadRequestException se tentar comprar item que não está active', async () => {
      selectChain.where.mockResolvedValueOnce([fakeListingSold]);
      await expect(
        service.createOrders('user_buyer', {
          items: [{ listingId: 'listing_002' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar ForbiddenException se tentar comprar o próprio item', async () => {
      selectChain.where.mockResolvedValueOnce([fakeListingOwn]);
      await expect(
        service.createOrders('user_buyer', {
          items: [{ listingId: 'listing_003' }],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deve ciar orders com sucesso para um carrinho válido', async () => {
      selectChain.where.mockResolvedValueOnce([fakeListingActive]);
      const result = await service.createOrders('user_buyer', {
        items: [{ listingId: 'listing_001' }],
      });

      expect(mockDb.transaction).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: 'order_123', status: 'pending' });
    });
  });
});
