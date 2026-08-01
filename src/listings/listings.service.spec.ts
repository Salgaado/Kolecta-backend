import { Test, TestingModule } from '@nestjs/testing';
import { ListingsService } from './listings.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { FounderService } from '../founder/founder.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import * as schema from '../database/schema';

// ─── Mock DB ──────────────────────────────────────────────────────────────────

const fakeListing = {
  id: 'listing_001',
  sellerId: 'user_seller',
  categoryId: null,
  title: 'Hot Wheels RLC Skyline',
  description: 'Item raro',
  brand: 'Hot Wheels',
  line: 'RLC',
  scale: '1:64',
  year: '2023',
  edition: 'Limited',
  condition: 'lacrado',
  type: 'direct',
  priceInCents: 50000,
  images: null,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const selectChain = {
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn(),
  offset: jest.fn(),
};

const updateChain = {
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue(undefined),
};

const deleteChain = {
  where: jest.fn().mockResolvedValue(undefined),
};

const insertChain = {
  values: jest.fn().mockResolvedValue(undefined),
};

// Transação (create): registra em qual tabela cada insert foi feito.
const txInsert = jest.fn(() => insertChain);
const mockTx = { insert: txInsert };

const mockDb = {
  select: () => selectChain,
  update: () => updateChain,
  delete: () => deleteChain,
  insert: () => insertChain,
  transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

// Emissor de eventos: só precisamos observar o que foi emitido.
const mockEventEmitter = { emit: jest.fn() };

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('ListingsService', () => {
  let service: ListingsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
        {
          provide: FounderService,
          useValue: { evaluate: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<ListingsService>(ListingsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── findById ───────────────────────────────────────────────────────────────
  describe('findById', () => {
    it('deve retornar o listing quando encontrado', async () => {
      selectChain.limit.mockResolvedValueOnce([fakeListing]);
      const result = await service.findById('listing_001');
      expect(result).toEqual(fakeListing);
    });

    it('deve lançar NotFoundException quando não encontrado', async () => {
      selectChain.limit.mockResolvedValueOnce([]);
      await expect(service.findById('nao_existe')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── create ─────────────────────────────────────────────────────────────────
  describe('create', () => {
    afterEach(() => {
      delete process.env.ENFORCE_SELLER_KYC;
    });

    const dto = {
      title: 'Hot Wheels RLC Skyline',
      condition: 'lacrado',
      type: 'direct' as const,
      priceInCents: 50000,
    };

    it('deve inserir e retornar o novo listing (gate OFF por padrão)', async () => {
      selectChain.limit
        .mockResolvedValueOnce([{ id: 'addr_1' }]) // assertHasOriginAddress
        .mockResolvedValueOnce([fakeListing]); // findById pós-insert

      const result = await service.create('user_seller', dto);

      expect(insertChain.values).toHaveBeenCalled();
      expect(result).toEqual(fakeListing);
    });

    it('sem endereço de origem cadastrado → BadRequestException', async () => {
      selectChain.limit.mockResolvedValueOnce([]); // nenhum endereço

      await expect(service.create('user_seller', dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(insertChain.values).not.toHaveBeenCalled();
    });

    it('com ENFORCE_SELLER_KYC=true e canReceive=false → ForbiddenException', async () => {
      process.env.ENFORCE_SELLER_KYC = 'true';
      selectChain.limit.mockResolvedValueOnce([{ canReceive: false }]);

      await expect(service.create('user_seller', dto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(insertChain.values).not.toHaveBeenCalled();
    });

    it('com ENFORCE_SELLER_KYC=true e canReceive=true → cria normalmente', async () => {
      process.env.ENFORCE_SELLER_KYC = 'true';
      selectChain.limit
        .mockResolvedValueOnce([{ canReceive: true }]) // assertCanSell
        .mockResolvedValueOnce([{ id: 'addr_1' }]) // assertHasOriginAddress
        .mockResolvedValueOnce([fakeListing]); // findById pós-insert

      const result = await service.create('user_seller', dto);

      expect(insertChain.values).toHaveBeenCalled();
      expect(result).toEqual(fakeListing);
    });

    it('type=auction cria o listing E a linha de auction (relógio parado)', async () => {
      selectChain.limit
        .mockResolvedValueOnce([{ id: 'addr_1' }]) // assertHasOriginAddress
        .mockResolvedValueOnce([{ ...fakeListing, type: 'auction' }]); // findById

      await service.create('user_seller', {
        title: 'Leilão X',
        condition: 'lacrado',
        type: 'auction',
        startingBidInCents: 100000,
        durationHours: 72,
      });

      const insertedTables = txInsert.mock.calls.map((c: any[]) => c[0]);
      expect(insertedTables).toContain(schema.listings);
      expect(insertedTables).toContain(schema.auctions);
    });

    it('type=auction sem startingBidInCents → BadRequestException', async () => {
      selectChain.limit.mockResolvedValueOnce([{ id: 'addr_1' }]); // passa o gate de endereço

      await expect(
        service.create('user_seller', {
          title: 'Leilão sem lance',
          condition: 'lacrado',
          type: 'auction',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('deve atualizar quando o sellerId bate', async () => {
      // findById (antes do update) + findById (pós update)
      selectChain.limit
        .mockResolvedValueOnce([fakeListing])
        .mockResolvedValueOnce([{ ...fakeListing, title: 'Novo Título' }]);

      const result = await service.update('listing_001', 'user_seller', {
        title: 'Novo Título',
      });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Novo Título' }),
      );
      expect(result.title).toBe('Novo Título');
    });

    it('deve lançar ForbiddenException se sellerId não bate', async () => {
      selectChain.limit.mockResolvedValueOnce([fakeListing]);

      await expect(
        service.update('listing_001', 'user_outro', { title: 'X' }),
      ).rejects.toThrow(ForbiddenException);
    });

    // ── Reprovado + editado volta para a fila ──
    // Sem isso o anúncio reprovado nunca mais chega na moderação: publish
    // recusa 'rejected' e a fila do admin só busca draft/pending_review.

    it('anúncio REPROVADO editado volta para pending_review', async () => {
      const reprovado = { ...fakeListing, status: 'rejected' };
      selectChain.limit
        .mockResolvedValueOnce([reprovado])
        .mockResolvedValueOnce([{ ...reprovado, status: 'pending_review' }]);

      await service.update('listing_001', 'user_seller', {
        title: 'Título corrigido',
      });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Título corrigido',
          status: 'pending_review',
        }),
      );
    });

    // ── Edição de anúncio ATIVO ──
    // Campo que a moderação avalia derruba para reanálise; o resto não. Fecha o
    // furo de aprovar limpo e trocar o conteúdo depois, sem punir quem corrige
    // o preço.

    it('mexer no TÍTULO de um anúncio ativo devolve para a fila', async () => {
      const ativo = { ...fakeListing, status: 'active' };
      selectChain.limit
        .mockResolvedValueOnce([ativo])
        .mockResolvedValueOnce([ativo]);

      await service.update('listing_001', 'user_seller', { title: 'Outro item' });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending_review' }),
      );
    });

    it('mexer só no PREÇO de um anúncio ativo não tira do ar', async () => {
      const ativo = { ...fakeListing, status: 'active' };
      selectChain.limit
        .mockResolvedValueOnce([ativo])
        .mockResolvedValueOnce([ativo]);

      await service.update('listing_001', 'user_seller', {
        priceInCents: 12345,
      });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.not.objectContaining({ status: expect.anything() }),
      );
    });

    it('reenviar o MESMO título não derruba o anúncio', async () => {
      // O front manda o formulário inteiro no PATCH; comparar valor (e não só
      // presença da chave) evita reanálise por edição que não mudou nada.
      const ativo = { ...fakeListing, status: 'active' };
      selectChain.limit
        .mockResolvedValueOnce([ativo])
        .mockResolvedValueOnce([ativo]);

      await service.update('listing_001', 'user_seller', {
        title: ativo.title,
        priceInCents: 999,
      });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.not.objectContaining({ status: expect.anything() }),
      );
    });
  });

  // ── remove ─────────────────────────────────────────────────────────────────
  describe('remove', () => {
    it('deve deletar quando o sellerId bate', async () => {
      selectChain.limit.mockResolvedValueOnce([fakeListing]);
      await service.remove('listing_001', 'user_seller');
      expect(deleteChain.where).toHaveBeenCalled();
    });

    it('deve lançar ForbiddenException se sellerId não bate', async () => {
      selectChain.limit.mockResolvedValueOnce([fakeListing]);

      await expect(service.remove('listing_001', 'user_outro')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── updateStatus ───────────────────────────────────────────────────────────
  describe('updateStatus', () => {
    it('deve atualizar o status (admin)', async () => {
      selectChain.limit
        .mockResolvedValueOnce([fakeListing])
        .mockResolvedValueOnce([{ ...fakeListing, status: 'active' }]);

      const result = await service.updateStatus('listing_001', 'active');

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' }),
      );
    });

    it('ao ativar um anúncio de leilão, inicia o relógio (endsAt)', async () => {
      const auctionListing = { ...fakeListing, type: 'auction' };
      selectChain.limit
        .mockResolvedValueOnce([auctionListing]) // findById inicial
        .mockResolvedValueOnce([
          {
            id: 'auc_1',
            endsAt: null,
            durationHours: 48,
            sellerId: 'seller_001',
            // Vendedor APTO: é o que autoriza o leilão a ir ao ar.
            recipientId: 're_seller',
            canReceive: true,
          },
        ]) // busca auction
        .mockResolvedValueOnce([auctionListing]); // findById final

      await service.updateStatus('listing_001', 'active');

      const set = updateChain.set.mock.calls.find(
        (c: any[]) => c[0]?.endsAt instanceof Date,
      )?.[0];
      expect(set).toBeDefined();
      // Vai ao ar de verdade: fim dentro da duração, não na sentinela de 2099.
      expect(set.endsAt.getTime()).toBeLessThan(
        Date.now() + 49 * 60 * 60 * 1000,
      );
      expect(set.pausedAt ?? null).toBeNull();
    });

    // Sem recebedor apto na Pagar.me todo lance é recusado por falta de split.
    // O leilão ia ao ar assim mesmo e ficava visível e indisputável — só o
    // script manual `pausar-leiloes.ts` segurava, e quem era ativado depois da
    // última rodada passava direto.
    it('vendedor SEM recebedor apto: leilão nasce pausado, não vai ao ar', async () => {
      const auctionListing = { ...fakeListing, type: 'auction' };
      selectChain.limit
        .mockResolvedValueOnce([auctionListing])
        .mockResolvedValueOnce([
          {
            id: 'auc_1',
            endsAt: null,
            durationHours: 48,
            sellerId: 'seller_001',
            recipientId: null,
            canReceive: false,
          },
        ])
        .mockResolvedValueOnce([auctionListing]);

      await service.updateStatus('listing_001', 'active');

      const set = updateChain.set.mock.calls.find(
        (c: any[]) => c[0]?.pausedAt instanceof Date,
      )?.[0];
      expect(set).toBeDefined();
      // Guarda a duração CHEIA: o leilão ainda não correu um minuto.
      expect(set.pausedRemainingMs).toBe(48 * 60 * 60 * 1000);
      // E some da vitrine pela sentinela distante, sem virar leilão encerrado.
      expect(set.endsAt.getUTCFullYear()).toBe(2099);
      expect(set.status).toBe('active');
    });

    // ── E-mail de moderação: só em ação de admin ──
    // A mesma chamada serve para o vendedor publicar sozinho; avisar alguém do
    // que ele mesmo acabou de fazer seria ruído.

    it('admin aprovando (moderatorId) emite listing.moderated → aprovado', async () => {
      selectChain.limit
        .mockResolvedValueOnce([fakeListing])
        .mockResolvedValueOnce([{ ...fakeListing, status: 'active' }]);

      await service.updateStatus('listing_001', 'active', {
        moderatorId: 'admin_1',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'listing.moderated',
        expect.objectContaining({
          template: 'listing-approved',
          listingId: 'listing_001',
          sellerId: fakeListing.sellerId,
        }),
      );
    });

    it('admin reprovando leva o motivo junto', async () => {
      selectChain.limit
        .mockResolvedValueOnce([fakeListing])
        .mockResolvedValueOnce([{ ...fakeListing, status: 'rejected' }]);

      await service.updateStatus('listing_001', 'rejected', {
        moderatorId: 'admin_1',
        reason: 'Fotos desfocadas',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'listing.moderated',
        expect.objectContaining({
          template: 'listing-rejected',
          reason: 'Fotos desfocadas',
        }),
      );
    });

    it('vendedor publicando sozinho (sem moderatorId) NÃO emite e-mail', async () => {
      selectChain.limit
        .mockResolvedValueOnce([fakeListing])
        .mockResolvedValueOnce([{ ...fakeListing, status: 'active' }]);

      await service.updateStatus('listing_001', 'active');

      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
        'listing.moderated',
        expect.anything(),
      );
    });
  });

  // ── publish (peneira de requisitos) ────────────────────────────────────────
  describe('publish', () => {
    const validDraft = {
      ...fakeListing,
      status: 'draft',
      description: 'Descrição bem completa do item colecionável raro e lacrado.',
      priceInCents: 50000,
      images: JSON.stringify(['a.jpg', 'b.jpg', 'c.jpg']),
      categoryId: 'cat_1',
      condition: 'lacrado',
      weightGrams: 200,
      widthCm: 10,
      heightCm: 10,
      lengthCm: 10,
    };

    it('bloqueia (400) quando faltam requisitos', async () => {
      const incompleto = {
        ...validDraft,
        description: 'curto', // < 30 chars
        images: null, // 0 fotos
        categoryId: null, // sem categoria
        weightGrams: null, // sem frete
      };
      selectChain.limit
        .mockResolvedValueOnce([incompleto]) // findById em publish
        .mockResolvedValueOnce([incompleto]); // findById em updateStatus

      await expect(
        service.publish('listing_001', 'user_seller'),
      ).rejects.toThrow(BadRequestException);
    });

    it('lança ForbiddenException se não é o dono', async () => {
      selectChain.limit.mockResolvedValueOnce([validDraft]);
      await expect(
        service.publish('listing_001', 'outro_user'),
      ).rejects.toThrow(ForbiddenException);
    });

    // ── A moderação é sempre quem ativa (decisão do dono, 24/07) ──
    // O vendedor ENVIA; `active` só pelo admin. Antes, `publish` colocava no ar
    // direto e a fila de moderação era decorativa.

    it('envia para a fila (pending_review), não para o ar', async () => {
      selectChain.limit
        .mockResolvedValueOnce([validDraft]) // findById em publish
        .mockResolvedValueOnce([validDraft]) // findById em updateStatus
        .mockResolvedValueOnce([]) // categoria em getPublishBlockers (slug desconhecido → pula campos)
        .mockResolvedValueOnce([{ ...validDraft, status: 'pending_review' }]);

      await service.publish('listing_001', 'user_seller');

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending_review' }),
      );
      expect(updateChain.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' }),
      );
    });

    it('recusa reenviar o que já está na fila', async () => {
      selectChain.limit.mockResolvedValueOnce([
        { ...validDraft, status: 'pending_review' },
      ]);

      await expect(
        service.publish('listing_001', 'user_seller'),
      ).rejects.toThrow(BadRequestException);
    });

    it('anúncio PAUSADO volta direto ao ar, sem passar pela fila', async () => {
      // Já foi aprovado uma vez; pausar é decisão do vendedor, não da moderação.
      const pausado = { ...validDraft, status: 'paused' };
      selectChain.limit
        .mockResolvedValueOnce([pausado]) // findById em publish
        .mockResolvedValueOnce([]) // categoria em getPublishBlockers
        .mockResolvedValueOnce([pausado]) // findById em updateStatus
        .mockResolvedValueOnce([{ ...pausado, status: 'active' }]);

      await service.publish('listing_001', 'user_seller');

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' }),
      );
    });
  });
});
