import { Test, TestingModule } from '@nestjs/testing';
import { WithdrawalsService } from './withdrawals.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { PagarmeService } from '../pagarme/pagarme.service';
import { WalletService } from '../wallet/wallet.service';
import { BadRequestException } from '@nestjs/common';

const mockUserId = 'user_seller_123';
const mockRecipientId = 'rp_test_abc';

const mockSellerProfile = {
  id: 'sp_001',
  userId: mockUserId,
  pagarmeRecipientId: mockRecipientId,
  canWithdraw: true,
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
  pagarmeRecipientId: mockRecipientId,
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
});

const mockPagarme = {
  post: jest.fn().mockResolvedValue({ id: 'tr_test_001', status: 'processing' }),
};

const mockWalletService = {
  getOrCreateWallet: jest.fn().mockResolvedValue(mockWallet),
  debit: jest.fn().mockResolvedValue({ success: true }),
  credit: jest.fn().mockResolvedValue({ success: true }),
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
        { provide: PagarmeService, useValue: mockPagarme },
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

    it('deve lançar BadRequestException se seller não tem recebedor Pagar.me', async () => {
      mockDb.where.mockResolvedValueOnce([]); // sellerProfile não encontrado
      await expect(
        service.requestWithdrawal(mockUserId, { amountInCents: 5000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar BadRequestException se o recebedor não pode sacar (canWithdraw=false)', async () => {
      mockDb.where.mockResolvedValueOnce([
        { ...mockSellerProfile, canWithdraw: false },
      ]);
      await expect(
        service.requestWithdrawal(mockUserId, { amountInCents: 5000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar BadRequestException se saldo disponível é insuficiente', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockWalletService.getOrCreateWallet.mockResolvedValueOnce({
        ...mockWallet,
        balanceInCents: 1000, // apenas R$10,00
      });
      await expect(
        service.requestWithdrawal(mockUserId, { amountInCents: 5000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve criar o saque (processing) e persistir o transfer id', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockWalletService.getOrCreateWallet.mockResolvedValueOnce(mockWallet);

      const result = await service.requestWithdrawal(mockUserId, {
        amountInCents: 5000,
      });

      // debitou o disponível e criou o transfer na Pagar.me
      expect(mockWalletService.debit).toHaveBeenCalledWith(
        mockWallet.id,
        5000,
        expect.any(String),
      );
      expect(mockPagarme.post).toHaveBeenCalledWith(
        '/transfers',
        expect.objectContaining({
          amount: 5000,
          recipient_id: mockRecipientId,
        }),
        expect.stringContaining('withdrawal-'),
      );
      expect(result.pagarmeTransferId).toBe('tr_test_001');
      expect(result.status).toBe('processing');
    });

    it('deve estornar o saldo se a criação do transfer falhar', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockWalletService.getOrCreateWallet.mockResolvedValueOnce(mockWallet);
      mockPagarme.post.mockRejectedValueOnce(new Error('pagarme 500'));

      await expect(
        service.requestWithdrawal(mockUserId, { amountInCents: 5000 }),
      ).rejects.toThrow();

      // estornou o débito
      expect(mockWalletService.credit).toHaveBeenCalledWith(
        mockWallet.id,
        5000,
        expect.any(String),
      );
    });
  });
});
