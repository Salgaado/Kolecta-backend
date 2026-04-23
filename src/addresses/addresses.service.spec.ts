import { Test, TestingModule } from '@nestjs/testing';
import { AddressesService } from './addresses.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { NotFoundException } from '@nestjs/common';

const mockUserId = 'user_test_123';
const mockAddressId = 'addr_test_456';

const mockAddress = {
  id: mockAddressId,
  userId: mockUserId,
  label: 'Casa',
  recipientName: 'João Silva',
  street: 'Rua das Flores',
  number: '123',
  complement: null,
  neighborhood: 'Centro',
  city: 'São Paulo',
  state: 'SP',
  zip: '01310-100',
  country: 'BR',
  isDefault: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Builder de mock Drizzle que suporta encadeamento completo
const makeDrizzleMock = (finalValue: any) => {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue(finalValue);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.set = jest.fn().mockReturnValue(chain);
  chain.delete = jest.fn().mockReturnValue(chain);
  return chain;
};

describe('AddressesService', () => {
  let service: AddressesService;
  let mockDb: any;

  const buildModule = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AddressesService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
      ],
    }).compile();

    return module.get<AddressesService>(AddressesService);
  };

  // ── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('deve retornar lista de endereços do usuário', async () => {
      mockDb = makeDrizzleMock([mockAddress]);
      mockDb.where.mockResolvedValueOnce([mockAddress]);
      service = await buildModule();

      const result = await service.findAll(mockUserId);
      expect(result).toEqual([mockAddress]);
    });
  });

  // ── create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('deve criar um novo endereço com sucesso', async () => {
      mockDb = makeDrizzleMock([mockAddress]);
      service = await buildModule();

      const dto = {
        recipientName: 'João Silva',
        street: 'Rua das Flores',
        number: '123',
        city: 'São Paulo',
        state: 'SP',
        zip: '01310-100',
      };

      const result = await service.create(mockUserId, dto);
      expect(result).toEqual(mockAddress);
    });
  });

  // ── update ──────────────────────────────────────────────────────────────

  describe('update', () => {
    it('deve lançar NotFoundException se endereço não existe', async () => {
      mockDb = makeDrizzleMock([]);
      mockDb.where.mockResolvedValue([]); // not found
      service = await buildModule();

      await expect(
        service.update(mockUserId, 'outro_id', { city: 'Rio' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve atualizar o endereço com sucesso', async () => {
      const updated = { ...mockAddress, city: 'Rio de Janeiro' };
      mockDb = makeDrizzleMock([updated]);
      // 1ª .where: find check → endereço existe
      // 2ª .where: update.where → não retorna nada (chain)
      // 3ª .where: select.where → retorna o endereço atualizado
      mockDb.where
        .mockResolvedValueOnce([mockAddress]) // find check
        .mockReturnValueOnce(mockDb) // update.where (chain — sem await direto)
        .mockResolvedValueOnce([updated]); // select.where final
      service = await buildModule();

      const result = await service.update(mockUserId, mockAddressId, {
        city: 'Rio de Janeiro',
      });
      expect(result).toEqual(updated);
    });
  });

  // ── remove ──────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('deve lançar NotFoundException ao deletar endereço inexistente', async () => {
      mockDb = makeDrizzleMock([]);
      mockDb.where.mockResolvedValue([]);
      service = await buildModule();

      await expect(
        service.remove(mockUserId, 'addr_inexistente'),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve deletar o endereço com sucesso', async () => {
      mockDb = makeDrizzleMock(undefined);
      mockDb.where
        .mockResolvedValueOnce([mockAddress])
        .mockResolvedValueOnce(undefined);
      service = await buildModule();

      await expect(
        service.remove(mockUserId, mockAddressId),
      ).resolves.not.toThrow();
    });
  });
});
