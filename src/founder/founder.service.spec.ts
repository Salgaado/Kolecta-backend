import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { FounderService } from './founder.service';
import { DATABASE_CONNECTION } from '../database/database.module';

// Mock Drizzle encadeável. `where` é o terminal dos selects (mockResolvedValueOnce
// em ordem); updates usam update().set().where().returning().
const makeDb = () => {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.groupBy = jest.fn().mockResolvedValue([]);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockResolvedValue([{}]);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.set = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue([{}]);
  return chain;
};

const userId = 'user_1';

describe('FounderService', () => {
  let service: FounderService;
  let db: any;

  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FounderService,
        { provide: DATABASE_CONNECTION, useValue: db },
      ],
    }).compile();
    return module.get<FounderService>(FounderService);
  };

  // ── evaluate: NUNCA concede o selo (só progresso) ────────────────────────

  describe('evaluate', () => {
    it('marca candidato (qualified) ao bater a meta, SEM número nem active', async () => {
      db = makeDb();
      db.where
        .mockResolvedValueOnce([
          { userId, founderNumber: null, founderStatus: 'none' },
        ]) // getOrCreateProfile
        .mockResolvedValueOnce([{ count: 6 }]); // countSubmittedListings (≥5)
      db.returning.mockResolvedValue([
        { userId, founderNumber: null, founderStatus: 'qualified' },
      ]);
      service = await build();

      const result = await service.evaluate(userId);

      expect(result.founderStatus).toBe('qualified');
      // Atualiza SÓ o status — nunca atribui número nem ativa.
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({ founderStatus: 'qualified' }),
      );
      const setArg = db.set.mock.calls[0][0];
      expect(setArg.founderNumber).toBeUndefined();
      expect(setArg.founderStatus).not.toBe('active');
    });

    it('marca pending quando ainda não bateu a meta', async () => {
      db = makeDb();
      db.where
        .mockResolvedValueOnce([
          { userId, founderNumber: null, founderStatus: 'none' },
        ])
        .mockResolvedValueOnce([{ count: 2 }]); // < 5
      db.returning.mockResolvedValue([
        { userId, founderNumber: null, founderStatus: 'pending' },
      ]);
      service = await build();

      const result = await service.evaluate(userId);
      expect(result.founderStatus).toBe('pending');
    });

    it('não mexe em quem já é fundador (número atribuído pela equipe)', async () => {
      db = makeDb();
      db.where.mockResolvedValueOnce([
        { userId, founderNumber: 60, founderStatus: 'active' },
      ]);
      service = await build();

      const result = await service.evaluate(userId);
      expect(result.founderNumber).toBe(60);
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // ── grantFounder: concessão pela equipe (número manual) ──────────────────

  describe('grantFounder', () => {
    const candidate = { userId, founderNumber: null, founderStatus: 'qualified' };

    it('rejeita número fora da faixa 51..100', async () => {
      db = makeDb();
      service = await build();
      await expect(service.grantFounder(userId, 10)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejeita se o usuário já é fundador', async () => {
      db = makeDb();
      db.where.mockResolvedValueOnce([
        { userId, founderNumber: 55, founderStatus: 'active' },
      ]);
      service = await build();
      await expect(service.grantFounder(userId, 60)).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejeita candidato não qualificado (< 5 anúncios)', async () => {
      db = makeDb();
      db.where
        .mockResolvedValueOnce([candidate]) // getOrCreateProfile
        .mockResolvedValueOnce([{ count: 3 }]); // countSubmittedListings
      service = await build();
      await expect(service.grantFounder(userId, 60)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejeita número já em uso', async () => {
      db = makeDb();
      db.where
        .mockResolvedValueOnce([candidate])
        .mockResolvedValueOnce([{ count: 5 }])
        .mockResolvedValueOnce([{ userId: 'outro' }]); // número tomado
      service = await build();
      await expect(service.grantFounder(userId, 60)).rejects.toThrow(
        ConflictException,
      );
    });

    it('concede com sucesso: número + active + créditos', async () => {
      db = makeDb();
      db.where
        .mockResolvedValueOnce([candidate]) // getOrCreateProfile
        .mockResolvedValueOnce([{ count: 5 }]) // qualificado
        .mockResolvedValueOnce([]) // número livre
        .mockResolvedValueOnce([]); // grantCredits: sem crédito prévio
      // Isola o update do fluxo dos selects (evita colisão na fila de where).
      db.set = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([
              { userId, founderNumber: 60, founderStatus: 'active' },
            ]),
        }),
      });
      service = await build();

      const result = await service.grantFounder(userId, 60);

      expect(result.founderNumber).toBe(60);
      expect(result.founderStatus).toBe('active');
      // Concedeu créditos (insert em founder_credits).
      expect(db.insert).toHaveBeenCalled();
    });
  });
});
