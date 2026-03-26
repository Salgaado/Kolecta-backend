import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { NotFoundException } from '@nestjs/common';
import * as schema from '../database/schema';

// ─── Mock do banco Drizzle ────────────────────────────────────────────────────
const fakeUser = {
  id: 'user_abc',
  email: 'test@kolecta.com',
  name: 'João Silva',
  role: 'buyer',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSelect = jest.fn();
const mockUpdate = jest.fn();

// Encadeia: select().from().where().limit()
const selectChain = {
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn(),
};

// Encadeia: update().set().where()
const updateChain = {
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue(undefined),
};

const mockDb = {
  select: () => selectChain,
  update: () => updateChain,
};

// ─── Suite ────────────────────────────────────────────────────────────────────
describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── findById ───────────────────────────────────────────────────────────────
  describe('findById', () => {
    it('deve retornar o usuário quando encontrado', async () => {
      selectChain.limit.mockResolvedValueOnce([fakeUser]);

      const result = await service.findById('user_abc');

      expect(result).toEqual(fakeUser);
    });

    it('deve lançar NotFoundException quando não encontrado', async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await expect(service.findById('user_nao_existe')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('deve atualizar e retornar o usuário atualizado', async () => {
      // Primeira chamada findById (verifica existência), segunda (retorna atualizado)
      selectChain.limit
        .mockResolvedValueOnce([fakeUser])
        .mockResolvedValueOnce([{ ...fakeUser, name: 'João Atualizado' }]);

      const result = await service.update('user_abc', {
        name: 'João Atualizado',
      });

      expect(result.name).toBe('João Atualizado');
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'João Atualizado' }),
      );
    });

    it('deve lançar NotFoundException ao atualizar usuário inexistente', async () => {
      selectChain.limit.mockResolvedValueOnce([]);

      await expect(
        service.update('user_nao_existe', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
