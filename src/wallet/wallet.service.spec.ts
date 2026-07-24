import { Test, TestingModule } from '@nestjs/testing';
import { WalletService } from './wallet.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Emissor de eventos: só precisamos observar o que foi emitido.
const mockEventEmitter = { emit: jest.fn() };

describe('WalletService', () => {
  let service: WalletService;

  const mockTx = {
    query: {
      wallets: {
        findFirst: jest.fn(),
      },
    },
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
  };

  const mockDb = {
    query: {
      wallets: {
        findFirst: jest.fn(),
      },
    },
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    // mock implementa a transação chamando o callback com mockTx
    transaction: jest.fn(async (cb) => {
      return cb(mockTx);
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: 'DATABASE_CONNECTION',
          useValue: mockDb,
        },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    jest.clearAllMocks();
  });

  it('deve estar definido', () => {
    expect(service).toBeDefined();
  });

  describe('credit', () => {
    it('deve retornar NotFoundException se a carteira não existir', async () => {
      mockTx.query.wallets.findFirst.mockResolvedValueOnce(null);

      await expect(service.credit('invalid-id', 1000, 'Test')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deve creditar valor e criar ledger status se a carteira existir', async () => {
      mockTx.query.wallets.findFirst.mockResolvedValueOnce({
        id: 'w1',
        balanceInCents: 500,
      });

      const res = await service.credit('w1', 1000, 'Test Credit');

      expect(res).toEqual({ success: true, newBalance: 1500 });
      expect(mockTx.update).toHaveBeenCalled();
      expect(mockTx.insert).toHaveBeenCalled();
    });
  });

  describe('debit', () => {
    it('deve retornar BadRequest se tentar debitar mais do que o balanço da carteira', async () => {
      mockTx.query.wallets.findFirst.mockResolvedValueOnce({
        id: 'w1',
        balanceInCents: 500,
      });

      await expect(service.debit('w1', 1000, 'Test')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('deve debitar com sucesso e persistir se os fundos forem suficientes', async () => {
      mockTx.query.wallets.findFirst.mockResolvedValueOnce({
        id: 'w1',
        balanceInCents: 1500,
      });

      const res = await service.debit('w1', 500, 'Test Debit');

      expect(res).toEqual({ success: true, newBalance: 1000 });
      expect(mockTx.update).toHaveBeenCalled();
      expect(mockTx.insert).toHaveBeenCalled();
    });
  });

  describe('hold', () => {
    it('deve adicionar o valor ao pendingInCents da wallet e gerar histórico em hold', async () => {
      mockTx.query.wallets.findFirst.mockResolvedValueOnce({
        id: 'w1',
        pendingInCents: 0,
      });

      const res = await service.hold('w1', 2000, 'Test Hold for Order');

      expect(res).toEqual({ success: true, newPending: 2000 });
      expect(mockTx.update).toHaveBeenCalled();
      expect(mockTx.insert).toHaveBeenCalled();
    });
  });
});
