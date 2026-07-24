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
      });
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
