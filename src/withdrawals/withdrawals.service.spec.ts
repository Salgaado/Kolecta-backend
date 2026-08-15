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
  // GET /recipients/{id}/balance — folga suficiente para não interferir nos
  // testes que não são sobre teto.
  get: jest.fn().mockResolvedValue({
    currency: 'BRL',
    available_amount: 100000,
    waiting_funds_amount: 0,
  }),
};

/** Taxa de saque da Pagar.me (R$ 3,67), cobrada por cima do valor pedido. */
const TAXA = 367;

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

    // clearAllMocks apaga as implementações default; restaura as que são
    // pré-condição da maioria dos testes.
    mockPagarme.post.mockResolvedValue({
      id: 'tr_test_001',
      status: 'processing',
    });
    mockPagarme.get.mockResolvedValue({
      currency: 'BRL',
      available_amount: 100000,
      waiting_funds_amount: 0,
    });
    mockWalletService.getOrCreateWallet.mockResolvedValue(mockWallet);
    mockWalletService.debit.mockResolvedValue({ success: true });
    mockWalletService.credit.mockResolvedValue({ success: true });
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

      // debitou VALOR + TAXA — o vendedor pede o líquido, a taxa vem por cima
      expect(mockWalletService.debit).toHaveBeenCalledWith(
        mockWallet.id,
        5000 + TAXA,
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

      // estornou o débito INTEIRO (valor + taxa) — devolver só o principal
      // deixaria a carteira R$ 3,67 mais pobre que o recebedor
      expect(mockWalletService.credit).toHaveBeenCalledWith(
        mockWallet.id,
        5000 + TAXA,
        expect.any(String),
      );
    });

    it('deve mandar para a Pagar.me só o VALOR, sem a taxa (quem cobra é ela)', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);

      await service.requestWithdrawal(mockUserId, { amountInCents: 5000 });

      expect(mockPagarme.post).toHaveBeenCalledWith(
        '/transfers',
        expect.objectContaining({ amount: 5000 }),
        expect.any(String),
      );
    });

    it('deve recusar quando o saldo cobre o valor mas NÃO a taxa', async () => {
      // O bug de 13/08: o vendedor pedia exatamente o saldo, passava na
      // validação antiga e a Pagar.me recusava por 3,67 de diferença.
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockWalletService.getOrCreateWallet.mockResolvedValueOnce({
        ...mockWallet,
        balanceInCents: 5000,
      });

      await expect(
        service.requestWithdrawal(mockUserId, { amountInCents: 5000 }),
      ).rejects.toThrow(BadRequestException);

      expect(mockWalletService.debit).not.toHaveBeenCalled();
    });

    it('deve barrar ANTES de debitar quando o recebedor não tem saldo real', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      // Carteira diz que dá; a Pagar.me diz que não. Sem esta checagem o saque
      // nasce condenado: debita, toma recusa e estorna.
      mockPagarme.get.mockResolvedValueOnce({ available_amount: 5100 });

      await expect(
        service.requestWithdrawal(mockUserId, { amountInCents: 5000 }),
      ).rejects.toThrow(BadRequestException);

      expect(mockWalletService.debit).not.toHaveBeenCalled();
      expect(mockPagarme.post).not.toHaveBeenCalled();
    });

    it('deve seguir pela carteira se a consulta de saldo falhar', async () => {
      // Degradar, não bloquear: saque indisponível porque a consulta caiu
      // seria trocar um problema raro por um diário.
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockPagarme.get.mockRejectedValueOnce(new Error('timeout'));

      const result = await service.requestWithdrawal(mockUserId, {
        amountInCents: 5000,
      });

      expect(result.pagarmeTransferId).toBe('tr_test_001');
      expect(mockWalletService.debit).toHaveBeenCalledWith(
        mockWallet.id,
        5000 + TAXA,
        expect.any(String),
      );
    });
  });

  // ── getLimits ────────────────────────────────────────────────────────────

  describe('getLimits', () => {
    it('deve descontar a taxa do máximo sacável', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);

      const limits = await service.getLimits(mockUserId);

      expect(limits.feeInCents).toBe(TAXA);
      expect(limits.balanceInCents).toBe(20000);
      expect(limits.maxWithdrawableInCents).toBe(20000 - TAXA);
      expect(limits.canWithdraw).toBe(true);
      expect(limits.limitSource).toBe('wallet');
    });

    it('deve usar o saldo da Pagar.me quando ele for MENOR que a carteira', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockPagarme.get.mockResolvedValueOnce({ available_amount: 16777 });

      const limits = await service.getLimits(mockUserId);

      // 167,77 − 3,67 = 164,10, o número que teria evitado as três tentativas
      expect(limits.maxWithdrawableInCents).toBe(16410);
      expect(limits.limitSource).toBe('pagarme');
    });

    it('deve cair na carteira quando a consulta de saldo falha', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockPagarme.get.mockRejectedValueOnce(new Error('503'));

      const limits = await service.getLimits(mockUserId);

      expect(limits.maxWithdrawableInCents).toBe(20000 - TAXA);
      expect(limits.limitSource).toBe('wallet');
    });

    it('não deve devolver máximo negativo com saldo abaixo da taxa', async () => {
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockWalletService.getOrCreateWallet.mockResolvedValueOnce({
        ...mockWallet,
        balanceInCents: 100,
      });
      mockPagarme.get.mockResolvedValueOnce({ available_amount: 100 });

      const limits = await service.getLimits(mockUserId);

      expect(limits.maxWithdrawableInCents).toBe(0);
    });

    it('deve marcar canWithdraw=false sem recebedor configurado', async () => {
      mockDb.where.mockResolvedValueOnce([
        { ...mockSellerProfile, pagarmeRecipientId: null },
      ]);

      const limits = await service.getLimits(mockUserId);

      expect(limits.canWithdraw).toBe(false);
      // sem recebedor não há o que consultar
      expect(mockPagarme.get).not.toHaveBeenCalled();
    });
  });
});
