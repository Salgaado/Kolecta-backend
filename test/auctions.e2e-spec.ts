import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  CanActivate,
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuctionsController } from '../src/auctions/auctions.controller';
import { AuctionsService } from '../src/auctions/auctions.service';
import { AuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockAuction = {
  id: 'auction_e2e_001',
  listingId: 'listing_001',
  startingBidInCents: 5000,
  minIncrementInCents: 1000,
  currentBidInCents: 5000,
  reservePriceInCents: null,
  currentWinnerId: null,
  durationHours: 48,
  endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  antiSniper: true,
  status: 'active',
  title: 'Hot Wheels RLC',
  images: null,
  condition: 'lacrado',
  sellerId: 'seller_001',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockBid = {
  id: 'bid_001',
  auctionId: 'auction_e2e_001',
  bidderId: 'buyer_001',
  amountInCents: 6500,
  createdAt: new Date().toISOString(),
};

// ── Guard mocks ───────────────────────────────────────────────────────────────

class AuthGuardAllow implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.auth = { userId: 'test-user' };
    return true;
  }
}

class AuthGuardDeny implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('Autenticação necessária');
  }
}

// ── AuctionsService mock ───────────────────────────────────────────────────────

const mockAuctionsService = {
  findAll: jest.fn().mockResolvedValue([mockAuction]),
  findById: jest.fn().mockResolvedValue(mockAuction),
  findMyBids: jest.fn().mockResolvedValue([]),
  findSellerAuctions: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockResolvedValue(mockAuction),
  placeBid: jest.fn().mockResolvedValue(mockBid),
  endAuction: jest.fn().mockResolvedValue(mockAuction),
};

// ── Suite ────────────────────────────────────────────────────────────────────

describe('AuctionsController (e2e)', () => {
  let app: INestApplication<App>;

  const buildApp = async (allowAuth = true) => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuctionsController],
      providers: [
        { provide: AuctionsService, useValue: mockAuctionsService },
      ],
    })
      .overrideGuard(AuthGuard)
      .useClass(allowAuth ? AuthGuardAllow : AuthGuardDeny)
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    return app;
  };

  afterEach(async () => {
    if (app) await app.close();
    jest.clearAllMocks();
  });

  // ── GET /api/auctions ─────────────────────────────────────────────────────

  describe('GET /api/auctions', () => {
    it('deve retornar 200 com lista de leilões', async () => {
      await buildApp();

      return request(app.getHttpServer())
        .get('/api/auctions')
        .expect(200)
        .expect((res) => {
          expect(res.body.data).toBeDefined();
          expect(Array.isArray(res.body.data)).toBe(true);
          expect(res.body.data[0].id).toBe(mockAuction.id);
        });
    });

    it('deve chamar findAll no service', async () => {
      await buildApp();

      await request(app.getHttpServer()).get('/api/auctions');

      expect(mockAuctionsService.findAll).toHaveBeenCalledTimes(1);
    });
  });

  // ── GET /api/auctions/:id ─────────────────────────────────────────────────

  describe('GET /api/auctions/:id', () => {
    it('deve retornar 200 com o leilão encontrado', async () => {
      await buildApp();

      return request(app.getHttpServer())
        .get('/api/auctions/auction_e2e_001')
        .expect(200)
        .expect((res) => {
          expect(res.body.data.id).toBe(mockAuction.id);
        });
    });

    it('deve retornar 404 se leilão não existe', async () => {
      mockAuctionsService.findById.mockRejectedValueOnce(
        new NotFoundException('Leilão não encontrado'),
      );
      await buildApp();

      return request(app.getHttpServer())
        .get('/api/auctions/nao-existe')
        .expect(404);
    });
  });

  // ── POST /api/auctions/:id/bids sem auth ─────────────────────────────────

  describe('POST /api/auctions/:id/bids', () => {
    it('deve retornar 401 quando não autenticado', async () => {
      await buildApp(false);

      return request(app.getHttpServer())
        .post('/api/auctions/qualquer/bids')
        .send({ amountInCents: 6000 })
        .expect(401);
    });

    it('deve retornar 201 quando autenticado e lance válido', async () => {
      await buildApp(true);

      return request(app.getHttpServer())
        .post('/api/auctions/auction_e2e_001/bids')
        .send({ amountInCents: 6500 })
        .expect(201)
        .expect((res) => {
          expect(res.body.data.id).toBe(mockBid.id);
        });
    });
  });

  // ── POST /api/auctions/:id/end sem auth ──────────────────────────────────

  describe('POST /api/auctions/:id/end', () => {
    it('deve retornar 401 quando não autenticado', async () => {
      await buildApp(false);

      return request(app.getHttpServer())
        .post('/api/auctions/qualquer/end')
        .expect(401);
    });

    it('deve retornar 200 quando autenticado', async () => {
      await buildApp(true);

      return request(app.getHttpServer())
        .post('/api/auctions/auction_e2e_001/end')
        .expect(200)
        .expect((res) => {
          expect(res.body.data).toBeDefined();
        });
    });
  });
});
