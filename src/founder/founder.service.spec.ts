import { GRANT_RANGE, NUMERO_DA_CASA } from './founder.constants';
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

    it('rejeita número fora da sequência 1..100', async () => {
      db = makeDb();
      service = await build();
      await expect(service.grantFounder(userId, 101)).rejects.toThrow(
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

/**
 * Faixa aceita na concessão. O #0 é a casa — a conta da marca-mãe. O resto é a
 * sequência de 1 a 100: a numeração real começou no #001 (sorteio de 25/07,
 * inserido direto no banco) e o endpoint recusava tudo abaixo de 51, então o
 * painel não conseguia conceder o #011 e a equipe ficava dependendo de INSERT
 * manual.
 */
describe('FounderService.grantFounder — faixa aceita', () => {
  const valido = (n: number) =>
    Number.isInteger(n) &&
    (n === NUMERO_DA_CASA || (n >= GRANT_RANGE.min && n <= GRANT_RANGE.max));

  it('aceita o 0 e a sequência inteira de 1 a 100', () => {
    expect(NUMERO_DA_CASA).toBe(0);
    expect(valido(0)).toBe(true);
    expect(valido(1)).toBe(true);
    // O número que o painel não conseguia conceder.
    expect(valido(11)).toBe(true);
    expect(valido(51)).toBe(true);
    expect(valido(100)).toBe(true);
  });

  it('recusa o que está fora da sequência', () => {
    expect(valido(101)).toBe(false);
    expect(valido(-1)).toBe(false);
    expect(valido(1.5)).toBe(false);
  });
});

/**
 * `resolveCommissionPercent` — a função que decide quanto a Kolecta cobra.
 *
 * É o único lugar que responde "quanto este vendedor paga": o fechamento do
 * pedido (orders.service) e o do leilão (auctions.service) chamam esta função.
 * Estava sem teste, e os outros specs só a mockavam devolvendo 11 — ou seja,
 * o caminho do fundador nunca era exercitado em teste nenhum.
 *
 * Conferido contra a produção em 05/08/2026: dos 12 pedidos pagos, os 10 de
 * fundador ativo saíram a 9% e os demais a 11%. Os dois da Artminis cobrados a
 * 11% são de 22/07 e 25/07, ANTES de ela virar fundadora em 31/07 — cobrança
 * correta na data, não regressão.
 */
describe('FounderService.resolveCommissionPercent', () => {
  const BASE = 11;
  const FUNDADOR = 9;
  let db: any;

  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FounderService, { provide: DATABASE_CONNECTION, useValue: db }],
    }).compile();
    return module.get<FounderService>(FounderService);
  };

  /** Perfil cujo benefício começou `meses` atrás. */
  const perfilDesdeMeses = (meses: number, status = 'active') => {
    const desde = new Date();
    desde.setMonth(desde.getMonth() - meses);
    return { userId, founderStatus: status, founderSince: desde };
  };

  const comPerfil = async (perfil: any) => {
    db = makeDb();
    db.where.mockResolvedValueOnce(perfil ? [perfil] : []);
    return (await build()).resolveCommissionPercent(userId);
  };

  afterEach(() => {
    delete process.env.PLATFORM_FEE_PERCENT;
  });

  it('fundador ativo, recém-concedido → 9%', async () => {
    expect(await comPerfil(perfilDesdeMeses(0))).toBe(FUNDADOR);
  });

  it('fundador ativo no meio da janela (3 meses) → 9%', async () => {
    expect(await comPerfil(perfilDesdeMeses(3))).toBe(FUNDADOR);
  });

  it('fundador ativo às vésperas do fim (5 meses) → ainda 9%', async () => {
    expect(await comPerfil(perfilDesdeMeses(5))).toBe(FUNDADOR);
  });

  // A janela é de 6 meses. Passou, volta à taxa cheia sozinho — ninguém precisa
  // rodar nada, e é por isso que não existe cron de expiração de desconto.
  it('passados 7 meses, o benefício expira e volta a 11%', async () => {
    expect(await comPerfil(perfilDesdeMeses(7))).toBe(BASE);
  });

  it('exatamente 6 meses já é fora da janela → 11%', async () => {
    expect(await comPerfil(perfilDesdeMeses(6))).toBe(BASE);
  });

  // Só 'active' tem desconto. Em produção havia 128 'pending' e 46 'qualified'
  // — todos pagam cheio, e é o comportamento correto.
  it.each(['qualified', 'pending', 'none', 'lapsed'])(
    'status "%s" não tem desconto → 11%%',
    async (status) => {
      expect(await comPerfil(perfilDesdeMeses(1, status))).toBe(BASE);
    },
  );

  it('active sem founderSince não ganha desconto (dado incompleto)', async () => {
    expect(
      await comPerfil({ userId, founderStatus: 'active', founderSince: null }),
    ).toBe(BASE);
  });

  it('vendedor sem perfil paga a taxa base', async () => {
    expect(await comPerfil(null)).toBe(BASE);
  });

  it('respeita PLATFORM_FEE_PERCENT para a taxa base', async () => {
    process.env.PLATFORM_FEE_PERCENT = '15';
    expect(await comPerfil(perfilDesdeMeses(7))).toBe(15);
  });

  it('o desconto do fundador NÃO segue a base: continua 9% mesmo com base 15', async () => {
    process.env.PLATFORM_FEE_PERCENT = '15';
    expect(await comPerfil(perfilDesdeMeses(1))).toBe(FUNDADOR);
  });
});

/**
 * `getMyStatus` precisa ENTREGAR a taxa ao front.
 *
 * É o primeiro elo da corrente que faz a tela ser reativa:
 *   getMyStatus → GET /api/founder/me → useCommissionRate() → o que a tela pinta
 *
 * Sem o campo aqui, o front não tem como saber a taxa e volta a chutar 11%,
 * que foi exatamente o bug: fundador cobrado 9% e vendo 11% no wizard.
 */
describe('FounderService.getMyStatus — entrega a taxa efetiva', () => {
  const montar = async (pct: number, status: string) => {
    const db = makeDb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [FounderService, { provide: DATABASE_CONNECTION, useValue: db }],
    }).compile();
    const service = module.get<FounderService>(FounderService);

    // As dependências de leitura não são o assunto: o que se testa é se a taxa
    // resolvida chega ao payload.
    jest.spyOn(service as any, 'evaluate').mockResolvedValue({
      founderNumber: status === 'active' ? 6 : null,
      founderStatus: status,
      founderSince: status === 'active' ? new Date('2026-07-25') : null,
    });
    jest.spyOn(service as any, 'countSubmittedListings').mockResolvedValue(5);
    jest.spyOn(service, 'resolveCommissionPercent').mockResolvedValue(pct);
    db.where.mockResolvedValue([]); // sem créditos

    return service.getMyStatus(userId);
  };

  it('fundador ativo: commissionPercent = 9, com a base junto para o "de/por"', async () => {
    const r: any = await montar(9, 'active');
    expect(r.commissionPercent).toBe(9);
    expect(r.baseCommissionPercent).toBe(11);
  });

  it('usuário comum: commissionPercent = 11', async () => {
    const r: any = await montar(11, 'none');
    expect(r.commissionPercent).toBe(11);
    expect(r.baseCommissionPercent).toBe(11);
  });

  it('a taxa vem de resolveCommissionPercent, e não de uma cópia da regra', async () => {
    const db = makeDb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [FounderService, { provide: DATABASE_CONNECTION, useValue: db }],
    }).compile();
    const service = module.get<FounderService>(FounderService);
    jest.spyOn(service as any, 'evaluate').mockResolvedValue({
      founderNumber: 6, founderStatus: 'active', founderSince: new Date('2026-07-25'),
    });
    jest.spyOn(service as any, 'countSubmittedListings').mockResolvedValue(5);
    const spy = jest.spyOn(service, 'resolveCommissionPercent').mockResolvedValue(9);
    db.where.mockResolvedValue([]);

    await service.getMyStatus(userId);

    // Mesma função que fecha o pedido e o leilão: uma fonte só.
    expect(spy).toHaveBeenCalledWith(userId);
  });
});
