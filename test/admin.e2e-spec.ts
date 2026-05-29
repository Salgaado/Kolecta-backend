import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AdminController } from '../src/admin/admin.controller';
import { AdminService } from '../src/admin/admin.service';
import { AuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockStats = {
  totalUsers: 42,
  totalListings: 10,
  totalOrders: 5,
  totalRevenueInCents: 150000,
  openDisputes: 2,
};

const mockUser = {
  id: 'user_001',
  email: 'admin@kolecta.com',
  name: 'Admin',
  role: 'admin',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockSellerProfile = {
  id: 'profile_001',
  userId: 'user_002',
  bio: 'Vendedor',
  isVerified: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockDispute = {
  id: 'dispute_001',
  orderId: 'order_001',
  reporterId: 'user_003',
  reason: 'Item não chegou',
  description: null,
  status: 'open',
  resolvedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── Guard factories ───────────────────────────────────────────────────────────

class AuthGuardAllow implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.auth = { userId: 'admin-user-id' };
    return true;
  }
}

class AuthGuardDeny implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('Autenticação necessária');
  }
}

class RolesGuardAllow implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

class RolesGuardDeny implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException('Acesso negado.');
  }
}

// ── AdminService mock ─────────────────────────────────────────────────────────

const mockAdminService = {
  getStats: jest.fn().mockResolvedValue(mockStats),
  listUsers: jest.fn().mockResolvedValue([mockUser]),
  updateUserRole: jest.fn().mockResolvedValue(mockUser),
  listSellers: jest.fn().mockResolvedValue([mockSellerProfile]),
  verifySeller: jest.fn().mockResolvedValue({ ...mockSellerProfile, isVerified: true }),
  listDisputes: jest.fn().mockResolvedValue([mockDispute]),
  resolveDispute: jest.fn().mockResolvedValue({ ...mockDispute, status: 'resolved' }),
  listListings: jest.fn().mockResolvedValue([]),
  updateListingStatus: jest.fn().mockResolvedValue({}),
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('AdminController (e2e)', () => {
  let app: INestApplication<App>;

  const buildApp = async (opts: { auth?: boolean; admin?: boolean } = {}) => {
    const { auth = true, admin = true } = opts;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: mockAdminService },
      ],
    })
      .overrideGuard(AuthGuard)
      .useClass(auth ? AuthGuardAllow : AuthGuardDeny)
      .overrideGuard(RolesGuard)
      .useClass(admin ? RolesGuardAllow : RolesGuardDeny)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    return app;
  };

  afterEach(async () => {
    if (app) await app.close();
    jest.clearAllMocks();
  });

  // ── GET /api/admin/stats ──────────────────────────────────────────────────

  describe('GET /api/admin/stats', () => {
    it('deve retornar 401 sem autenticação', async () => {
      await buildApp({ auth: false });

      return request(app.getHttpServer())
        .get('/api/admin/stats')
        .expect(401);
    });

    it('deve retornar 403 para usuário comum (sem role admin)', async () => {
      await buildApp({ auth: true, admin: false });

      return request(app.getHttpServer())
        .get('/api/admin/stats')
        .expect(403);
    });

    it('deve retornar 200 com stats para admin', async () => {
      await buildApp({ auth: true, admin: true });

      return request(app.getHttpServer())
        .get('/api/admin/stats')
        .expect(200)
        .expect((res) => {
          expect(res.body.data).toMatchObject({
            totalUsers: expect.any(Number),
            totalListings: expect.any(Number),
            totalOrders: expect.any(Number),
            totalRevenueInCents: expect.any(Number),
            openDisputes: expect.any(Number),
          });
        });
    });

    it('deve retornar shape completo das estatísticas', async () => {
      await buildApp({ auth: true, admin: true });

      return request(app.getHttpServer())
        .get('/api/admin/stats')
        .expect(200)
        .expect((res) => {
          expect(res.body.data.totalUsers).toBe(42);
          expect(res.body.data.openDisputes).toBe(2);
        });
    });
  });

  // ── GET /api/admin/users ──────────────────────────────────────────────────

  describe('GET /api/admin/users', () => {
    it('deve retornar 200 com array de usuários para admin', async () => {
      await buildApp({ auth: true, admin: true });

      return request(app.getHttpServer())
        .get('/api/admin/users')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body.data)).toBe(true);
          expect(res.body.data[0].id).toBe('user_001');
        });
    });

    it('deve retornar 401 sem autenticação', async () => {
      await buildApp({ auth: false });

      return request(app.getHttpServer())
        .get('/api/admin/users')
        .expect(401);
    });
  });

  // ── PATCH /api/admin/sellers/:id/verify ──────────────────────────────────

  describe('PATCH /api/admin/sellers/:id/verify', () => {
    it('deve retornar 404 se perfil não existe', async () => {
      mockAdminService.verifySeller.mockRejectedValueOnce(
        new NotFoundException('Perfil de vendedor não encontrado'),
      );
      await buildApp({ auth: true, admin: true });

      return request(app.getHttpServer())
        .patch('/api/admin/sellers/nao-existe/verify')
        .send({ verified: true })
        .expect(404);
    });

    it('deve retornar 200 com seller verificado', async () => {
      await buildApp({ auth: true, admin: true });

      return request(app.getHttpServer())
        .patch('/api/admin/sellers/profile_001/verify')
        .send({ verified: true })
        .expect(200)
        .expect((res) => {
          expect(res.body.data.isVerified).toBe(true);
        });
    });

    it('deve retornar 401 sem autenticação', async () => {
      await buildApp({ auth: false });

      return request(app.getHttpServer())
        .patch('/api/admin/sellers/profile_001/verify')
        .send({ verified: true })
        .expect(401);
    });
  });

  // ── PATCH /api/admin/disputes/:id ────────────────────────────────────────

  describe('PATCH /api/admin/disputes/:id', () => {
    it('deve retornar 404 se disputa não existe', async () => {
      mockAdminService.resolveDispute.mockRejectedValueOnce(
        new NotFoundException('Disputa não encontrada'),
      );
      await buildApp({ auth: true, admin: true });

      return request(app.getHttpServer())
        .patch('/api/admin/disputes/nao-existe')
        .send({ status: 'resolved' })
        .expect(404);
    });

    it('deve retornar 200 com disputa atualizada', async () => {
      await buildApp({ auth: true, admin: true });

      return request(app.getHttpServer())
        .patch('/api/admin/disputes/dispute_001')
        .send({ status: 'resolved' })
        .expect(200)
        .expect((res) => {
          expect(res.body.data.status).toBe('resolved');
        });
    });

    it('deve retornar 401 sem autenticação', async () => {
      await buildApp({ auth: false });

      return request(app.getHttpServer())
        .patch('/api/admin/disputes/dispute_001')
        .send({ status: 'resolved' })
        .expect(401);
    });

    it('deve retornar 403 para usuário sem role admin', async () => {
      await buildApp({ auth: true, admin: false });

      return request(app.getHttpServer())
        .patch('/api/admin/disputes/dispute_001')
        .send({ status: 'resolved' })
        .expect(403);
    });
  });

  // ── GET /api/admin/sellers ────────────────────────────────────────────────

  describe('GET /api/admin/sellers', () => {
    it('deve retornar 200 com lista de sellers para admin', async () => {
      await buildApp({ auth: true, admin: true });

      return request(app.getHttpServer())
        .get('/api/admin/sellers')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body.data)).toBe(true);
        });
    });
  });
});
