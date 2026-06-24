import { ReviewsService } from './reviews.service';
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';

const buyerId = 'buyer_123';
const sellerId = 'seller_456';
const orderId = 'order_789';

const baseOrder = {
  id: orderId,
  buyerId,
  sellerId,
  status: 'delivered',
};

const insertedReview = {
  id: 'review_001',
  orderId,
  authorId: buyerId,
  targetId: sellerId,
  rating: 5,
  comment: 'Ótimo vendedor',
  createdAt: new Date(),
};

// Mock db cobrindo db.query.* e a cadeia db.insert().values().returning()
const makeDb = ({
  order = baseOrder,
  existingReview = undefined,
  inserted = insertedReview,
}: {
  order?: any;
  existingReview?: any;
  inserted?: any;
} = {}) => ({
  query: {
    orders: { findFirst: jest.fn().mockResolvedValue(order) },
    reviews: { findFirst: jest.fn().mockResolvedValue(existingReview) },
  },
  insert: jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([inserted]),
    }),
  }),
});

describe('ReviewsService', () => {
  describe('createReview', () => {
    it('cria avaliação quando comprador avalia vendedor de pedido entregue', async () => {
      const db = makeDb();
      const service = new ReviewsService(db as any);

      const result = await service.createReview(buyerId, {
        orderId,
        rating: 5,
        comment: 'Ótimo vendedor',
      });

      expect(result).toEqual(insertedReview);
      // targetId deve ser a contraparte (o vendedor)
      const valuesArg = (db.insert().values as jest.Mock).mock.calls[0][0];
      expect(valuesArg.targetId).toBe(sellerId);
      expect(valuesArg.authorId).toBe(buyerId);
    });

    it('resolve targetId como comprador quando o vendedor é o autor', async () => {
      const db = makeDb();
      const service = new ReviewsService(db as any);

      await service.createReview(sellerId, { orderId, rating: 4 });

      const valuesArg = (db.insert().values as jest.Mock).mock.calls[0][0];
      expect(valuesArg.targetId).toBe(buyerId);
    });

    it('lança BadRequest se a nota está fora de 1–5', async () => {
      const service = new ReviewsService(makeDb() as any);
      await expect(
        service.createReview(buyerId, { orderId, rating: 6 }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createReview(buyerId, { orderId, rating: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('lança NotFound se o pedido não existe', async () => {
      const service = new ReviewsService(makeDb({ order: null }) as any);
      await expect(
        service.createReview(buyerId, { orderId, rating: 5 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('lança Forbidden se o autor não participou do pedido', async () => {
      const service = new ReviewsService(makeDb() as any);
      await expect(
        service.createReview('estranho_999', { orderId, rating: 5 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lança Forbidden se o pedido ainda não foi entregue/concluído', async () => {
      const service = new ReviewsService(
        makeDb({ order: { ...baseOrder, status: 'paid' } }) as any,
      );
      await expect(
        service.createReview(buyerId, { orderId, rating: 5 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('aceita pedido com status completed', async () => {
      const db = makeDb({ order: { ...baseOrder, status: 'completed' } });
      const service = new ReviewsService(db as any);
      await expect(
        service.createReview(buyerId, { orderId, rating: 5 }),
      ).resolves.toEqual(insertedReview);
    });

    it('lança Conflict se o autor já avaliou este pedido', async () => {
      const service = new ReviewsService(
        makeDb({ existingReview: insertedReview }) as any,
      );
      await expect(
        service.createReview(buyerId, { orderId, rating: 5 }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
