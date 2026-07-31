/**
 * Segmentação do disparo (`docs/PLAN-pagarme-conta-nova.md`, Fase 4.1).
 *
 * O erro que estes testes existem para impedir: o pedido de recadastro sair
 * para a base inteira em vez dos ~24 vendedores afetados. São 453 pessoas que
 * não têm nada a fazer, e o ruído dilui justamente o aviso de quem precisa
 * agir. O caminho inverso é igualmente ruim — um comunicado geral que só
 * alcance 24 pessoas passa despercebido.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DATABASE_CONNECTION } from '../database/database.module';
import { BroadcastService } from './broadcast.service';
import { MailService } from './mail/mail.service';

const TODOS = [
  { email: 'comprador@gmail.com', name: 'Comprador' },
  { email: 'vendedor@gmail.com', name: 'GT RACE' },
  { email: 'semear@email.com', name: 'Semente' }, // domínio de teste
];

const RECADASTRO = [
  { email: 'vendedor@gmail.com', name: 'GT RACE' },
  { email: 'loja@hotmail.com', name: '1021 Performance' },
];

describe('BroadcastService — audiência', () => {
  let service: BroadcastService;
  let mail: { send: jest.Mock };
  let whereMock: jest.Mock;

  beforeEach(async () => {
    // `select().from().where()` (todos) e
    // `select().from().innerJoin().where()` (recadastro) terminam no mesmo
    // `where`, então cada teste decide o que ele resolve.
    whereMock = jest.fn();
    const chain: any = {
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: whereMock,
    };
    const db = { select: jest.fn().mockReturnValue(chain) };
    mail = { send: jest.fn().mockResolvedValue(undefined) };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        BroadcastService,
        { provide: DATABASE_CONNECTION, useValue: db },
        { provide: MailService, useValue: mail },
      ],
    }).compile();

    service = mod.get(BroadcastService);
  });

  /** 1ª chamada: a lista de alvos. 2ª: o email_log (campanha ainda vazia). */
  const semear = (alvos: unknown[]) => {
    whereMock.mockResolvedValueOnce(alvos).mockResolvedValueOnce([]);
  };

  const ensaiar = (audiencia?: 'todos' | 'recebedores-a-recadastrar') =>
    service.enviar({
      template: 'recadastro-recebedor',
      campanha: 'recadastro-2026-08',
      ...(audiencia ? { audiencia } : {}),
    });

  it('sem audiencia no corpo, mira toda a base', async () => {
    semear(TODOS);
    const r = await ensaiar();

    expect(r.audiencia).toBe('todos');
    // A conta de semente (@email.com) continua fora.
    expect(r.total).toBe(2);
  });

  it('audiencia de recadastro mira só os vendedores afetados', async () => {
    semear(RECADASTRO);
    const r = await ensaiar('recebedores-a-recadastrar');

    expect(r.audiencia).toBe('recebedores-a-recadastrar');
    expect(r.total).toBe(2);
    expect(r.amostra).toEqual(['vendedor@gmail.com', 'loja@hotmail.com']);
  });

  it('a audiência escolhida volta na resposta — o ensaio precisa dizer para quem contou', async () => {
    semear(RECADASTRO);
    const r = await ensaiar('recebedores-a-recadastrar');

    // Sem este campo, um ensaio de 24 e um de 453 são indistinguíveis no
    // retorno, e a conferência antes do disparo real perde o sentido.
    expect(r).toHaveProperty('audiencia', 'recebedores-a-recadastrar');
  });

  it('continua sendo ensaio por padrão, seja qual for a audiência', async () => {
    semear(RECADASTRO);
    const r = await ensaiar('recebedores-a-recadastrar');

    expect(r.dryRun).toBe(true);
    expect(r.enviados).toBe(0);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('apenasPara vence a audiência: manda para um endereço só', async () => {
    semear(RECADASTRO);
    const r = await service.enviar({
      template: 'recadastro-recebedor',
      campanha: 'recadastro-2026-08',
      audiencia: 'recebedores-a-recadastrar',
      apenasPara: 'eu@kolecta.com.br',
    });

    expect(r.total).toBe(1);
    expect(r.amostra).toEqual(['eu@kolecta.com.br']);
  });
});
