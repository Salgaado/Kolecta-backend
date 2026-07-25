import { Test, TestingModule } from '@nestjs/testing';
import { AdminService } from './admin.service';
import { ListingsService } from '../listings/listings.service';
import { FounderService } from '../founder/founder.service';
import { MailService } from '../notifications/mail/mail.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { NotFoundException, BadRequestException } from '@nestjs/common';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockUser = {
  id: 'user_001',
  email: 'admin@kolecta.com',
  name: 'Admin',
  role: 'admin',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSellerProfile = {
  id: 'profile_001',
  userId: 'user_002',
  bio: 'Vendedor de colecionáveis',
  stripeAccountId: null,
  stripeOnboardingStatus: 'not_started',
  stripeChargesEnabled: false,
  stripePayoutsEnabled: false,
  isVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockDispute = {
  id: 'dispute_001',
  orderId: 'order_001',
  reporterId: 'user_003',
  reason: 'Item não chegou',
  description: 'O item não foi entregue após 30 dias',
  status: 'open',
  resolvedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockListing = {
  id: 'listing_001',
  sellerId: 'user_002',
  title: 'Hot Wheels RLC Exclusivo',
  condition: 'lacrado',
  type: 'direct',
  status: 'active',
  priceInCents: 15000,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Drizzle mock builder ───────────────────────────────────────────────────────
//
// Estratégia de terminais:
//   SELECT chains:  select → from → [where|orderBy|limit|offset] → resolve
//   UPDATE chains:  update → set → where → returning → resolve
//
// `where` retorna `chain` por padrão para suportar update().set().where().returning()
// Para SELECTs que terminam em `.where()`, use mockResolvedValueOnce nos testes.
// Para SELECTs que terminam em `.orderBy()`, `.limit()` ou `.offset()`, esses resolvem.

const makeDrizzleMock = () => {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  // where retorna chain por padrão (para suportar update chain)
  // Testes de SELECT que terminam em where devem usar mockResolvedValueOnce
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.offset = jest.fn().mockResolvedValue([mockUser]);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue([mockUser]);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.set = jest.fn().mockReturnValue(chain);
  return chain;
};

// ── Suite principal ───────────────────────────────────────────────────────────

describe('AdminService', () => {
  let service: AdminService;
  let mockDb: any;
  let listingsService: { updateStatus: jest.Mock };
  let founderService: { listCandidates: jest.Mock; grantFounder: jest.Mock };
  let mailService: { send: jest.Mock };

  const buildModule = async () => {
    listingsService = { updateStatus: jest.fn() };
    founderService = {
      listCandidates: jest.fn(),
      grantFounder: jest.fn(),
    };
    mailService = { send: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
        { provide: ListingsService, useValue: listingsService },
        { provide: FounderService, useValue: founderService },
        { provide: MailService, useValue: mailService },
      ],
    }).compile();

    return module.get<AdminService>(AdminService);
  };

  // ── getStats ──────────────────────────────────────────────────────────────
  //
  // getStats faz Promise.all de 7 queries:
  //   [0] select(count).from(users)                      — terminal: from()
  //   [1] select(count).from(listings)                   — terminal: from()
  //   [2] select(count).from(orders)                     — terminal: from()
  //   [3] select(count).from(listings).where(active)     — terminal: where()
  //   [4] select(sum).from(orders).where(status=completed) — terminal: where()
  //   [5] select(count).from(disputes).where(status=open)  — terminal: where()
  //   [6] select(count).from(auctions).innerJoin(listings).where(...) — where()
  //
  // Como os terminais são diferentes, usamos mockResolvedValueOnce para `from`
  // nas 3 primeiras chamadas (que não têm .where) e para `where` nas 3 últimas.

  describe('getStats', () => {
    it('deve retornar o shape correto com contagens e receita', async () => {
      mockDb = makeDrizzleMock();
      // queries [0],[1],[2] terminam em from()
      mockDb.from
        .mockResolvedValueOnce([{ total: 42 }])  // users count
        .mockResolvedValueOnce([{ total: 7 }])   // listings count
        .mockResolvedValueOnce([{ total: 3 }])   // orders count — para where() mais abaixo
        .mockReturnValue(mockDb);                 // fallback: retorna chain para queries com .where()
      // queries [3],[4] terminam em where()
      mockDb.where
        .mockResolvedValueOnce([{ total: 5 }])      // anuncios NO AR
        .mockResolvedValueOnce([{ total: 50000 }]) // revenue (orders where completed)
        .mockResolvedValueOnce([{ total: 2 }])      // open disputes
        .mockResolvedValueOnce([{ total: 4 }]);     // leiloes no ar (auction + listing ativos)

      service = await buildModule();
      const stats = await service.getStats();

      expect(stats).toHaveProperty('totalUsers');
      expect(stats).toHaveProperty('totalListings');
      expect(stats).toHaveProperty('totalOrders');
      expect(stats).toHaveProperty('totalRevenueInCents');
      expect(stats).toHaveProperty('openDisputes');
      expect(stats.totalUsers).toBe(42);
      expect(stats.totalListings).toBe(7);
      // "no ar" e um numero DIFERENTE do total: e a correcao do painel, que
      // mostrava 878 anuncios com 136 na vitrine.
      expect(stats.activeListings).toBe(5);
      expect(stats.activeAuctions).toBe(4);
    });

    it('deve retornar zeros quando todas as tabelas estão vazias', async () => {
      mockDb = makeDrizzleMock();
      mockDb.from
        .mockResolvedValueOnce([{ total: 0 }])
        .mockResolvedValueOnce([{ total: 0 }])
        .mockResolvedValueOnce([{ total: 0 }])
        .mockReturnValue(mockDb);
      mockDb.where
        .mockResolvedValueOnce([{ total: 0 }])    // anuncios no ar
        .mockResolvedValueOnce([{ total: null }]) // revenue null → deve ser 0
        .mockResolvedValueOnce([{ total: 0 }])    // disputes
        .mockResolvedValueOnce([{ total: 0 }]);   // leiloes no ar

      service = await buildModule();
      const stats = await service.getStats();

      expect(stats.totalRevenueInCents).toBe(0);
      expect(stats.openDisputes).toBe(0);
    });

    it('deve retornar totalRevenueInCents como número', async () => {
      mockDb = makeDrizzleMock();
      mockDb.from
        .mockResolvedValueOnce([{ total: 5 }])
        .mockResolvedValueOnce([{ total: 10 }])
        .mockResolvedValueOnce([{ total: 2 }])
        .mockReturnValue(mockDb);
      mockDb.where
        .mockResolvedValueOnce([{ total: 4 }])       // anuncios no ar
        .mockResolvedValueOnce([{ total: '99999' }]) // sum retorna string no SQLite
        .mockResolvedValueOnce([{ total: 1 }])       // disputes
        .mockResolvedValueOnce([{ total: 3 }]);      // leiloes no ar

      service = await buildModule();
      const stats = await service.getStats();

      expect(typeof stats.totalRevenueInCents).toBe('number');
      expect(stats.totalRevenueInCents).toBe(99999);
    });
  });

  // ── listUsers ─────────────────────────────────────────────────────────────

  describe('listUsers', () => {
    it('deve retornar array de usuários paginados', async () => {
      mockDb = makeDrizzleMock();
      mockDb.offset.mockResolvedValue([mockUser, { ...mockUser, id: 'user_002' }]);
      service = await buildModule();

      const result = await service.listUsers(50, 0);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(mockDb.limit).toHaveBeenCalled();
      expect(mockDb.offset).toHaveBeenCalled();
    });

    it('deve usar limit e offset corretos', async () => {
      mockDb = makeDrizzleMock();
      mockDb.offset.mockResolvedValue([]);
      service = await buildModule();

      await service.listUsers(10, 20);

      expect(mockDb.limit).toHaveBeenCalledWith(10);
      expect(mockDb.offset).toHaveBeenCalledWith(20);
    });
  });

  // ── updateUserRole ────────────────────────────────────────────────────────

  describe('updateUserRole', () => {
    it('deve lançar NotFoundException se usuário não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // usuário não encontrado
      service = await buildModule();

      await expect(
        service.updateUserRole('nope', { role: 'admin' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve retornar usuário atualizado quando encontrado', async () => {
      mockDb = makeDrizzleMock();
      const updatedUser = { ...mockUser, role: 'admin' };

      // Primeira chamada: SELECT .where() → resolve com [mockUser]
      // Segunda chamada: UPDATE .where() → retorna chain (padrão) para permitir .returning()
      mockDb.where.mockResolvedValueOnce([mockUser]);

      // returning do update resolve com usuário atualizado
      mockDb.returning.mockResolvedValueOnce([updatedUser]);

      service = await buildModule();
      const result = await service.updateUserRole('user_001', { role: 'admin' });

      expect(result).toEqual(updatedUser);
    });
  });

  // ── listSellers ───────────────────────────────────────────────────────────

  describe('listSellers', () => {
    it('deve retornar todos os sellers quando verified não é fornecido', async () => {
      const verifiedProfile = { ...mockSellerProfile, isVerified: true };
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([mockSellerProfile, verifiedProfile]);
      service = await buildModule();

      const result = await service.listSellers();

      expect(result.length).toBe(2);
    });

    it('deve retornar apenas sellers verificados quando verified=true', async () => {
      const verifiedProfile = { ...mockSellerProfile, id: 'profile_002', isVerified: true };
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([mockSellerProfile, verifiedProfile]);
      service = await buildModule();

      const result = await service.listSellers(true);

      expect(result.length).toBe(1);
      expect(result[0].isVerified).toBe(true);
    });

    it('deve retornar apenas sellers não verificados quando verified=false', async () => {
      const verifiedProfile = { ...mockSellerProfile, id: 'profile_002', isVerified: true };
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([mockSellerProfile, verifiedProfile]);
      service = await buildModule();

      const result = await service.listSellers(false);

      expect(result.length).toBe(1);
      expect(result[0].isVerified).toBe(false);
    });
  });

  // ── verifySeller ──────────────────────────────────────────────────────────

  describe('verifySeller', () => {
    it('deve lançar NotFoundException se perfil não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // perfil não encontrado
      service = await buildModule();

      await expect(
        service.verifySeller('profile_nope', true),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve atualizar isVerified para true quando perfil existe', async () => {
      const updatedProfile = { ...mockSellerProfile, isVerified: true };
      mockDb = makeDrizzleMock();
      // SELECT: where resolves com perfil; UPDATE: where retorna chain (padrão)
      mockDb.where.mockResolvedValueOnce([mockSellerProfile]);
      mockDb.returning.mockResolvedValueOnce([updatedProfile]);
      service = await buildModule();

      const result = await service.verifySeller('profile_001', true);

      expect(result.isVerified).toBe(true);
    });

    it('deve atualizar isVerified para false (remoção de verificação)', async () => {
      const profileVerified = { ...mockSellerProfile, isVerified: true };
      const updatedProfile = { ...profileVerified, isVerified: false };
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([profileVerified]);
      mockDb.returning.mockResolvedValueOnce([updatedProfile]);
      service = await buildModule();

      const result = await service.verifySeller('profile_001', false);

      expect(result.isVerified).toBe(false);
    });
  });

  // ── listDisputes ──────────────────────────────────────────────────────────

  describe('listDisputes', () => {
    it('deve retornar todas as disputas quando status não é fornecido', async () => {
      const resolvedDispute = { ...mockDispute, id: 'dispute_002', status: 'resolved' };
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([mockDispute, resolvedDispute]);
      service = await buildModule();

      const result = await service.listDisputes();

      expect(result.length).toBe(2);
    });

    it('deve retornar apenas disputas abertas quando status="open"', async () => {
      const resolvedDispute = { ...mockDispute, id: 'dispute_002', status: 'resolved' };
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([mockDispute, resolvedDispute]);
      service = await buildModule();

      const result = await service.listDisputes('open');

      expect(result.length).toBe(1);
      expect(result[0].status).toBe('open');
    });

    it('deve retornar array vazio se não há disputas com o status informado', async () => {
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([mockDispute]); // só tem 'open'
      service = await buildModule();

      const result = await service.listDisputes('resolved');

      expect(result).toEqual([]);
    });
  });

  // ── resolveDispute ────────────────────────────────────────────────────────

  describe('resolveDispute', () => {
    it('deve lançar NotFoundException se disputa não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // disputa não encontrada
      service = await buildModule();

      await expect(
        service.resolveDispute('dispute_nope', { status: 'resolved' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar BadRequestException se disputa já está "resolved"', async () => {
      const resolvedDispute = { ...mockDispute, status: 'resolved' };
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([resolvedDispute]);
      service = await buildModule();

      await expect(
        service.resolveDispute('dispute_001', { status: 'closed' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar BadRequestException se disputa já está "closed"', async () => {
      const closedDispute = { ...mockDispute, status: 'closed' };
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([closedDispute]);
      service = await buildModule();

      await expect(
        service.resolveDispute('dispute_001', { status: 'resolved' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve atualizar status e retornar disputa resolvida', async () => {
      const updatedDispute = { ...mockDispute, status: 'resolved', resolvedAt: new Date() };
      mockDb = makeDrizzleMock();
      // SELECT: where resolve com disputa aberta; UPDATE: where retorna chain (padrão)
      mockDb.where.mockResolvedValueOnce([mockDispute]);
      mockDb.returning.mockResolvedValueOnce([updatedDispute]);
      service = await buildModule();

      const result = await service.resolveDispute('dispute_001', { status: 'resolved' });

      expect(result.status).toBe('resolved');
      expect(result.resolvedAt).toBeDefined();
    });

    it('deve atualizar para "under_review" sem setar resolvedAt', async () => {
      const updatedDispute = { ...mockDispute, status: 'under_review', resolvedAt: null };
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([mockDispute]);
      mockDb.returning.mockResolvedValueOnce([updatedDispute]);
      service = await buildModule();

      const result = await service.resolveDispute('dispute_001', { status: 'under_review' });

      expect(result.status).toBe('under_review');
      expect(result.resolvedAt).toBeNull();
    });
  });

  // ── listListings ──────────────────────────────────────────────────────────

  describe('listListings', () => {
    it('deve retornar listings paginados com nome do vendedor (join)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.offset.mockResolvedValue([
        { listing: mockListing, sellerName: 'Garagem do Dan' },
      ]);
      service = await buildModule();

      const result = await service.listListings();

      expect(Array.isArray(result)).toBe(true);
      expect(result[0].id).toBe('listing_001');
      expect(result[0].sellerName).toBe('Garagem do Dan');
      expect(mockDb.leftJoin).toHaveBeenCalled();
    });

    it('deve filtrar por status no SQL (where) quando fornecido', async () => {
      mockDb = makeDrizzleMock();
      // A filtragem agora acontece no banco: a query já devolve só o status pedido.
      mockDb.offset.mockResolvedValue([
        { listing: { ...mockListing, status: 'active' }, sellerName: null },
      ]);
      service = await buildModule();

      const result = await service.listListings('active');

      expect(mockDb.where).toHaveBeenCalled();
      expect(result.length).toBe(1);
      expect(result[0].status).toBe('active');
      expect(result[0].sellerName).toBeNull();
    });

    it('não aplica where quando status não é fornecido', async () => {
      mockDb = makeDrizzleMock();
      mockDb.offset.mockResolvedValue([
        { listing: mockListing, sellerName: 'Vendedor A' },
        { listing: { ...mockListing, id: 'listing_002' }, sellerName: 'Vendedor B' },
      ]);
      service = await buildModule();

      const result = await service.listListings();

      expect(result.length).toBe(2);
      // where é chamado com undefined (sem filtro), mas o Drizzle ignora undefined
      expect(mockDb.where).toHaveBeenCalledWith(undefined);
    });
  });

  // ── updateListingStatus ───────────────────────────────────────────────────

  describe('updateListingStatus', () => {
    it('delega ao ListingsService.updateStatus (inicia relógio do leilão na ativação)', async () => {
      const updatedListing = { ...mockListing, status: 'active' };
      mockDb = makeDrizzleMock();
      service = await buildModule();
      listingsService.updateStatus.mockResolvedValueOnce(updatedListing);

      const result = await service.updateListingStatus('listing_001', 'active');

      // Agora repassa opts (reason/moderatorId) — undefined quando não fornecido.
      expect(listingsService.updateStatus).toHaveBeenCalledWith(
        'listing_001',
        'active',
        undefined,
      );
      expect(result.status).toBe('active');
    });

    it('propaga NotFoundException do ListingsService', async () => {
      mockDb = makeDrizzleMock();
      service = await buildModule();
      listingsService.updateStatus.mockRejectedValueOnce(
        new NotFoundException('Anúncio não encontrado'),
      );

      await expect(
        service.updateListingStatus('listing_nope', 'active'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
