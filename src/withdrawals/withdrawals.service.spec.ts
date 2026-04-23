import { Test, TestingModule } from '@nestjs/testing';
import { WithdrawalsService } from './withdrawals.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { StripeService } from '../stripe/stripe.service';
import { WalletService } from '../wallet/wallet.service';
import { BadRequestException } from '@nestjs/common';

const mockUserId = 'user_seller_123';
const mockStripeAccountId = 'acct_test_abc';

const mockSellerProfile = {
  id: 'sp_001',
  userId: mockUserId,
  stripeAccountId: mockStripeAccountId,
  isVerified: true,
};

const mockWallet = {
  id: 'wallet_001',
  userId: mockUserId,
  balanceInCents: 20000, // R$200,00
  pendingInCents: 0,
};

const mockWithdrawal = {
  id: 'wd_001',
  userId: mockUserId,
  amountInCents: 5000,
  status: 'processing',
  stripePayoutId: 'po_test_001',
  stripeAccountId: mockStripeAccountId,
};

const makeDb = () => ({
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue([mockWithdrawal]),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([mockWithdrawal]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  transaction: jest.fn().mockImplementation(async (fn: any) =>
    fn({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([mockWithdrawal]),
    }),
  ),
});

const mockStripeService = {
  stripe: {
    accounts: {
      retrieve: jest.fn().mockResolvedValue({
        charges_enabled: true,
        payouts_enabled: true,
      }),
    },
    payouts: {
      create: jest.fn().mockResolvedValue({ id: 'po_test_001' }),
    },
  },
};

const mockWalletService = {
  getOrCreateWallet: jest.fn().mockResolvedValue(mockWallet),
};

describe('WithdrawalsService', () => {
  let service: WithdrawalsService;
  let mockDb: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    mockDb = makeDb();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WithdrawalsService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
        { provide: StripeService, useValue: mockStripeService },
        { provide: WalletService, useValue: mockWalletService },
      ],
    }).compile();

    service = module.get<WithdrawalsService>(WithdrawalsService);
    jest.clearAllMocks();
  });

  // ── findMyWithdrawals ────────────────────────────────────────────────────

  describe('findMyWithdrawals', () => {
    it('deve retornar lista de saques do seller', async () => {
      mockDb.where.mockResolvedValueOnce([mockWithdrawal]);
      const result = await service.findMyWithdrawals(mockUserId);
      expect(result).toEqual([mockWithdrawal]);
    });
  });

  // ── requestWithdrawal ────────────────────────────────────────────────────

  describe('requestWithdrawal', () => {
    it('deve lançar BadRequestException se valor < R$50,00', async () => {
      await expect(
        service.requestWithdrawal(mockUserId, { amountInCents: 4999 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar BadRequestException se seller não tem conta Stripe Connect', async () => {
      mockDb.where.mockResolvedValueOnce([]); // sellerProfile not found

      await expect(
        service.requestWithdrawal(mockUserId, { amountInCents: 5000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar BadRequestException se conta Stripe não está habilitada', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockStripeService.stripe.accounts.retrieve.mockResolvedValueOnce({
        charges_enabled: false,
        payouts_enabled: false,
      });

      await expect(
        service.requestWithdrawal(mockUserId, { amountInCents: 5000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar BadRequestException se saldo disponível é insuficiente', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockStripeService.stripe.accounts.retrieve.mockResolvedValueOnce({
        charges_enabled: true,
        payouts_enabled: true,
      });
      mockWalletService.getOrCreateWallet.mockResolvedValueOnce({
        ...mockWallet,
        balanceInCents: 1000, // apenas R$10,00
      });

      await expect(
        service.requestWithdrawal(mockUserId, { amountInCents: 5000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve criar saque com sucesso e retornar o withdrawal', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockStripeService.stripe.accounts.retrieve.mockResolvedValueOnce({
        charges_enabled: true,
        payouts_enabled: true,
      });
      mockWalletService.getOrCreateWallet.mockResolvedValueOnce(mockWallet);
      mockStripeService.stripe.payouts.create.mockResolvedValueOnce({
        id: 'po_test_001',
      });

      const result = await service.requestWithdrawal(mockUserId, {
        amountInCents: 5000,
      });

      expect(result).toEqual(mockWithdrawal);
    });
  });
});
