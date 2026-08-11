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
  role: 'user',
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

    // Defense-in-depth contra privesc: mesmo que `role` burle o ValidationPipe
    // (whitelist), o service NUNCA pode persistir role via self-service.
    it('NÃO deve atualizar role mesmo se enviado no payload (anti-privesc)', async () => {
      selectChain.limit
        .mockResolvedValueOnce([fakeUser])
        .mockResolvedValueOnce([fakeUser]);

      await service.update('user_abc', {
        name: 'João',
        role: 'admin',
      } as any);

      const setArg = updateChain.set.mock.calls[0][0];
      expect(setArg).not.toHaveProperty('role');
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.not.objectContaining({ role: expect.anything() }),
      );
    });
  });
});

/**
 * Cadastro que nasce sem os dados do Clerk.
 *
 * `fetchClerkUser` estoura em QUALQUER resposta não-2xx. Em 08/08/2026 um
 * comprador entrou por login do Google e a chamada falhou no instante do
 * cadastro — a sessão já vale no callback, mas o registro pode não ter
 * propagado. Nome e e-mail viraram sintéticos, e o `findOrCreate` devolvia cedo
 * em toda chamada seguinte: ninguém nunca mais olhava aquele registro. Ele
 * seguiu ativo, arrematou dois leilões (R$ 460) e não recebeu um único aviso,
 * porque todos foram para `<id>@placeholder.kolecta` — domínio que não existe.
 */
describe('UsersService — cadastro placeholder se cura sozinho', () => {
  let service: UsersService;
  const PLACEHOLDER = {
    ...fakeUser,
    email: 'user_abc@placeholder.kolecta',
    name: 'Novo Usuário',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
      ],
    }).compile();
    service = mod.get<UsersService>(UsersService);
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
  });

  it('troca o placeholder pelos dados reais quando o Clerk volta a responder', async () => {
    // 1ª leitura: o registro placeholder. 2ª: o findById de depois do reparo.
    const curado = {
      ...fakeUser,
      email: 'billy@real.com.br',
      name: 'billy gois',
    };
    selectChain.limit
      .mockResolvedValueOnce([PLACEHOLDER])
      .mockResolvedValueOnce([curado]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        emailAddresses: [{ emailAddress: 'billy@real.com.br' }],
        firstName: 'billy',
        lastName: 'gois',
      }),
    }) as any;

    const r = await service.findOrCreate('user_abc');

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'billy@real.com.br',
        name: 'billy gois',
      }),
    );
    expect(r.email).toBe('billy@real.com.br');
  });

  /**
   * O reparo é socorro, não pré-requisito: se o Clerk falhar de novo, a
   * requisição que só queria saber quem é o usuário não pode morrer junto.
   */
  it('devolve o registro como está quando o Clerk falha de novo', async () => {
    selectChain.limit.mockResolvedValueOnce([PLACEHOLDER]);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 404 }) as any;

    const r = await service.findOrCreate('user_abc');

    expect(r).toEqual(PLACEHOLDER);
    expect(updateChain.set).not.toHaveBeenCalled();
  });

  /**
   * Sem e-mail no Clerk não há o que curar. Sem esta guarda, todo request de um
   * usuário nessa situação gastaria uma chamada à API do Clerk, para sempre.
   */
  it('não tenta gravar quando o Clerk também não tem e-mail', async () => {
    selectChain.limit.mockResolvedValueOnce([PLACEHOLDER]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        emailAddresses: [],
        firstName: null,
        lastName: null,
      }),
    }) as any;

    const r = await service.findOrCreate('user_abc');

    expect(r).toEqual(PLACEHOLDER);
    expect(updateChain.set).not.toHaveBeenCalled();
  });

  it('não gasta chamada ao Clerk para quem já tem e-mail de verdade', async () => {
    selectChain.limit.mockResolvedValueOnce([fakeUser]);
    global.fetch = jest.fn() as any;

    const r = await service.findOrCreate('user_abc');

    expect(r).toEqual(fakeUser);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
