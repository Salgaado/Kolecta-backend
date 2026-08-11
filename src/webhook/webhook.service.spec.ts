import { Test, TestingModule } from '@nestjs/testing';
import { WebhookService } from './webhook.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';

// ─── Mock do banco Drizzle ────────────────────────────────────────────────────
const mockInsert = jest
  .fn()
  .mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) });
const mockUpdate = jest.fn().mockReturnValue({
  set: jest
    .fn()
    .mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
});
const mockDelete = jest
  .fn()
  .mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });

const mockDb = {
  insert: mockInsert,
  update: mockUpdate,
  delete: mockDelete,
};

// ─── Dados de fixture ─────────────────────────────────────────────────────────
const userCreatedEvt = {
  type: 'user.created',
  data: {
    id: 'user_abc123',
    email_addresses: [{ email_address: 'test@kolecta.com' }],
    first_name: 'João',
    last_name: 'Silva',
  },
};

const userUpdatedEvt = {
  type: 'user.updated',
  data: {
    id: 'user_abc123',
    email_addresses: [{ email_address: 'novo@kolecta.com' }],
    first_name: 'João',
    last_name: 'Atualizado',
  },
};

const userDeletedEvt = {
  type: 'user.deleted',
  data: { id: 'user_abc123' },
};

// Emissor de eventos: só precisamos observar o que foi emitido.
const mockEventEmitter = { emit: jest.fn() };

// ─── Suite ────────────────────────────────────────────────────────────────────
describe('WebhookService', () => {
  let service: WebhookService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── user.created ──────────────────────────────────────────────────────────
  describe('user.created', () => {
    it('deve chamar db.insert com os dados corretos', async () => {
      await service.handleEvent(userCreatedEvt);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith('user.registered', {
        id: 'user_abc123',
        email: 'test@kolecta.com',
        name: 'João Silva',
      });

      expect(mockInsert).toHaveBeenCalledWith(schema.users);
      const valuesCall = mockInsert.mock.results[0].value.values;
      expect(valuesCall).toHaveBeenCalledWith({
        id: 'user_abc123',
        email: 'test@kolecta.com',
        name: 'João Silva',
        // Cadastro sem foto: `has_image: false` → nada a guardar. O front já
        // desenha as iniciais quando não há avatar, então gravar o avatar
        // gerado pelo Clerk só mascararia a ausência de foto.
        avatarUrl: null,
      });
    });

    it('guarda a foto do Clerk quando o usuário tem uma', async () => {
      await service.handleEvent({
        type: 'user.created',
        data: {
          ...userCreatedEvt.data,
          has_image: true,
          image_url: 'https://img.clerk.com/abc.png',
        },
      });

      const valuesCall = mockInsert.mock.results[0].value.values;
      expect(valuesCall).toHaveBeenCalledWith(
        expect.objectContaining({
          avatarUrl: 'https://img.clerk.com/abc.png',
        }),
      );
    });

    it('ignora o avatar gerado pelo Clerk (has_image false)', async () => {
      await service.handleEvent({
        type: 'user.created',
        data: {
          ...userCreatedEvt.data,
          has_image: false,
          image_url: 'https://img.clerk.com/iniciais-geradas.png',
        },
      });

      const valuesCall = mockInsert.mock.results[0].value.values;
      expect(valuesCall).toHaveBeenCalledWith(
        expect.objectContaining({ avatarUrl: null }),
      );
    });
  });

  // ── user.updated ──────────────────────────────────────────────────────────
  describe('user.updated', () => {
    it('deve chamar db.update com os dados corretos', async () => {
      await service.handleEvent(userUpdatedEvt);

      expect(mockUpdate).toHaveBeenCalledWith(schema.users);
      const setCall = mockUpdate.mock.results[0].value.set;
      expect(setCall).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'novo@kolecta.com',
          name: 'João Atualizado',
        }),
      );
    });
  });

  // ── user.deleted ──────────────────────────────────────────────────────────
  describe('user.deleted', () => {
    it('deve chamar db.delete com o id correto', async () => {
      await service.handleEvent(userDeletedEvt);

      expect(mockDelete).toHaveBeenCalledWith(schema.users);
      const whereCall = mockDelete.mock.results[0].value.where;
      expect(whereCall).toHaveBeenCalled();
    });
  });

  // ── evento desconhecido ───────────────────────────────────────────────────
  describe('evento desconhecido', () => {
    it('não deve chamar insert, update ou delete', async () => {
      await service.handleEvent({ type: 'session.created', data: {} });

      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});

/**
 * Falha de inserção no `user.created`.
 *
 * O erro era engolido e o controller respondia 200 assim mesmo: o Clerk marcava
 * como entregue e nunca mais tentava. O usuário virava um fantasma — autenticava
 * normalmente, porque o JWT é válido, mas só entrava no nosso banco pelo
 * `findOrCreate`, que sem os dados do Clerk grava placeholder. Foi assim que um
 * comprador arrematou dois leilões em 11/08/2026 sem receber um único aviso.
 *
 * O caso mais comum é `email` nulo — a coluna é NOT NULL — num cadastro social
 * cujo endereço ainda não propagou. É exatamente o que uma reentrega resolve.
 */
describe('WebhookService — user.created que falha ao inserir', () => {
  const evt = {
    type: 'user.created',
    data: {
      id: 'user_fantasma',
      email_addresses: [],
      first_name: 'billy',
      last_name: 'gois',
      has_image: false,
    },
  };

  function montar(usuarioJaExiste: boolean) {
    const limit = jest
      .fn()
      .mockResolvedValue(usuarioJaExiste ? [{ id: 'user_fantasma' }] : []);
    const db = {
      insert: jest.fn().mockReturnValue({
        values: jest
          .fn()
          .mockRejectedValue(
            new Error('NOT NULL constraint failed: users.email'),
          ),
      }),
      update: jest.fn(),
      delete: jest.fn(),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit,
      }),
    };
    const emitter = { emit: jest.fn() };
    return { service: new WebhookService(db as any, emitter as any), emitter };
  }

  it('propaga o erro para o Clerk reenviar', async () => {
    const { service, emitter } = montar(false);

    await expect(service.handleEvent(evt)).rejects.toThrow(/NOT NULL/);
    // Não deu boas-vindas a quem não entrou no banco.
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  /**
   * O Clerk reenvia por padrão. Sem esta guarda, a segunda entrega bateria na
   * chave primária, viraria erro de novo e prenderia o webhook num laço de
   * retry eterno por um usuário que já está no banco.
   */
  it('trata reentrega de usuário já existente como sucesso', async () => {
    const { service, emitter } = montar(true);

    await expect(service.handleEvent(evt)).resolves.toBeUndefined();
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
