import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { WalletService } from '../wallet/wallet.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FounderService } from '../founder/founder.service';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';

// ─── Mock DB ──────────────────────────────────────────────────────────────────

const fakeListingActive = {
  id: 'listing_001',
  sellerId: 'user_seller',
  title: 'Hot Wheels',
  status: 'active',
  priceInCents: 50000,
};

const fakeListingSold = {
  id: 'listing_002',
  sellerId: 'user_seller_2',
  title: 'Matchbox',
  status: 'sold',
  priceInCents: 10000,
};

const fakeListingOwn = {
  id: 'listing_003',
  sellerId: 'user_buyer', // mesmo dono do buyer
  title: 'Meu Produto',
  status: 'active',
  priceInCents: 5000,
};

const selectChain = {
  from: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn(),
};

// `where` é encadeável (mockReturnThis) para suportar `.where().returning()`
// (cancelPendingOrder); e o objeto é "thenable" para que `await update().set().where()`
// (sem returning) resolva undefined como antes.
const updateChain: any = {
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  returning: jest
    .fn()
    .mockResolvedValue([{ id: 'order_123', status: 'cancelled' }]),
  then: (resolve: any) => resolve(undefined),
};

const insertChain = {
  values: jest.fn().mockReturnThis(),
  returning: jest
    .fn()
    .mockResolvedValue([{ id: 'order_123', status: 'pending' }]),
};

const mockTx = {
  update: () => updateChain,
  insert: () => insertChain,
};

const mockDb = {
  select: () => selectChain,
  update: () => updateChain,
  insert: () => insertChain,
  transaction: jest.fn(async (cb) => cb(mockTx)),
};

// Mock do WalletService — hold é chamado no handleCheckoutCompleted
const mockWalletService = {
  hold: jest.fn().mockResolvedValue({ success: true }),
  getOrCreateWallet: jest
    .fn()
    .mockResolvedValue({ id: 'wallet_001', balanceInCents: 0 }),
};

// Mock do PagarmeService — post('/orders') retorna uma cobrança PIX com QR
const mockPagarmeService = {
  post: jest.fn().mockResolvedValue({
    id: 'or_test',
    status: 'pending',
    charges: [
      {
        id: 'ch_test',
        last_transaction: {
          qr_code: '00020126...pix',
          qr_code_url: 'https://pagar.me/qr.png',
          expires_at: '2026-07-20T13:00:00Z',
        },
      },
    ],
  }),
  // get('/orders/:id') usado na reconciliação (cancelamento manual + cron)
  get: jest.fn().mockResolvedValue({ id: 'or_test', status: 'failed', charges: [] }),
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('OrdersService', () => {
  let service: OrdersService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
        { provide: WalletService, useValue: mockWalletService },
        { provide: PagarmeService, useValue: mockPagarmeService },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: FounderService,
          useValue: { resolveCommissionPercent: jest.fn().mockResolvedValue(11) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  describe('createOrders', () => {
    it('deve lançar BadRequestException se o carrinho for vazio', async () => {
      await expect(
        service.createOrders('user_buyer', { items: [] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar NotFoundException se itens solicitados nao existirem', async () => {
      selectChain.where.mockResolvedValueOnce([]); // banco não acha nada
      await expect(
        service.createOrders('user_buyer', {
          items: [{ listingId: 'fake_123' }],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar BadRequestException se tentar comprar item que não está active', async () => {
      selectChain.where.mockResolvedValueOnce([fakeListingSold]);
      await expect(
        service.createOrders('user_buyer', {
          items: [{ listingId: 'listing_002' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar ForbiddenException se tentar comprar o próprio item', async () => {
      selectChain.where.mockResolvedValueOnce([fakeListingOwn]);
      await expect(
        service.createOrders('user_buyer', {
          items: [{ listingId: 'listing_003' }],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deve ciar orders com sucesso para um carrinho válido', async () => {
      selectChain.where.mockResolvedValueOnce([fakeListingActive]);
      const result = await service.createOrders('user_buyer', {
        items: [{ listingId: 'listing_001' }],
      });

      expect(mockDb.transaction).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: 'order_123', status: 'pending' });
    });

    it('persiste o CPF do comprador (só dígitos) quando informado', async () => {
      selectChain.where.mockResolvedValueOnce([fakeListingActive]);

      await service.createOrders('user_buyer', {
        items: [{ listingId: 'listing_001' }],
        buyerCpf: '529.982.247-25', // CPF válido (com máscara)
      });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ cpf: '52998224725' }),
      );
    });
  });

  // ── Checkout: escolha de instrumento (PIX vs cartão) ───────────────────────
  describe('createCheckout — instrumento de pagamento', () => {
    const baseDto = {
      items: [{ listingId: 'listing_001' }],
      buyerCpf: '529.982.247-25',
      buyerPhone: '11987654321',
    };

    it('default (sem paymentMethod) cai no PIX e retorna QR Code', async () => {
      selectChain.where
        .mockResolvedValueOnce([fakeListingActive]) // listing
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfile
        .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com', cpf: null }]); // buyer

      const result = await service.createCheckout('user_buyer', baseDto);

      const postBody = mockPagarmeService.post.mock.calls[0][1];
      expect(postBody.payments[0].payment_method).toBe('pix');
      expect(result.qrCode).toBeDefined();
      expect(result.paidViaWallet).toBe(false);
      expect(mockWalletService.hold).not.toHaveBeenCalled();
    });

    it('cartão APROVADO confirma na hora (hold do vendedor) e não retorna QR', async () => {
      selectChain.where
        .mockResolvedValueOnce([fakeListingActive]) // listing
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfile
        .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com', cpf: null }]) // buyer
        // confirmOrderPayment (inline): order → buyer → listing
        .mockResolvedValueOnce([
          {
            id: 'order_123',
            status: 'pending',
            buyerId: 'user_buyer',
            sellerId: 'user_seller',
            listingId: 'listing_001',
            totalInCents: 50000,
            shippingInCents: 0,
            externalAmountInCents: 50000,
            paymentInstrument: 'credit_card',
          },
        ])
        .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com' }])
        .mockResolvedValueOnce([{ title: 'Hot Wheels' }]);

      mockPagarmeService.post.mockResolvedValueOnce({
        id: 'or_card',
        status: 'paid',
        charges: [
          { id: 'ch_card', status: 'paid', last_transaction: { status: 'captured' } },
        ],
      });

      const result = await service.createCheckout('user_buyer', {
        ...baseDto,
        paymentMethod: 'credit_card',
        cardToken: 'tok_test',
        installments: 3,
      });

      const postBody = mockPagarmeService.post.mock.calls[0][1];
      expect(postBody.payments[0].payment_method).toBe('credit_card');
      expect(postBody.payments[0].credit_card.installments).toBe(3);
      expect(postBody.payments[0].credit_card.card_token).toBe('tok_test');
      expect(result.paidViaCard).toBe(true);
      expect(result.installments).toBe(3);
      expect(result.qrCode).toBeUndefined();
      // Confirmação síncrona → líquido do vendedor entra como saldo retido.
      expect(mockWalletService.hold).toHaveBeenCalledTimes(1);
    });

    it('cartão RECUSADO faz rollback e lança a mensagem do gateway', async () => {
      selectChain.where
        .mockResolvedValueOnce([fakeListingActive]) // listing
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfile
        .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com', cpf: null }]); // buyer

      mockPagarmeService.post.mockResolvedValueOnce({
        id: 'or_card',
        status: 'failed',
        charges: [
          {
            id: 'ch_card',
            status: 'failed',
            last_transaction: {
              status: 'refused',
              gateway_response: {
                errors: [{ message: 'Cartão recusado pelo emissor' }],
              },
            },
          },
        ],
      });

      await expect(
        service.createCheckout('user_buyer', {
          ...baseDto,
          paymentMethod: 'credit_card',
          cardToken: 'tok_test',
          installments: 1,
        }),
      ).rejects.toThrow('Cartão recusado pelo emissor');

      // Rollback: pedido cancelado, listing devolvido; nada retido ao vendedor.
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'cancelled' }),
      );
      expect(mockWalletService.hold).not.toHaveBeenCalled();
    });

    it('cartão NÃO combina com saldo: cobra o valor cheio mesmo com useWalletBalance', async () => {
      selectChain.where
        .mockResolvedValueOnce([fakeListingActive]) // listing
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfile
        .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com', cpf: null }]) // buyer
        .mockResolvedValueOnce([
          {
            id: 'order_123',
            status: 'pending',
            buyerId: 'user_buyer',
            sellerId: 'user_seller',
            listingId: 'listing_001',
            totalInCents: 50000,
            shippingInCents: 0,
            externalAmountInCents: 50000,
            paymentInstrument: 'credit_card',
          },
        ])
        .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com' }])
        .mockResolvedValueOnce([{ title: 'Hot Wheels' }]);

      mockPagarmeService.post.mockResolvedValueOnce({
        id: 'or_card',
        status: 'paid',
        charges: [
          { id: 'ch_card', status: 'paid', last_transaction: { status: 'captured' } },
        ],
      });

      const result = await service.createCheckout('user_buyer', {
        ...baseDto,
        useWalletBalance: true, // deve ser ignorado no cartão
        paymentMethod: 'credit_card',
        cardToken: 'tok_test',
        installments: 1,
      });

      // Valor cobrado no cartão = total cheio (nenhum abatimento de saldo).
      const postBody = mockPagarmeService.post.mock.calls[0][1];
      expect(postBody.items[0].amount).toBe(50000);
      expect(result.paidViaCard).toBe(true);
      expect(result.walletDeducted).toBe(0);
    });

    it('cartão sem token é rejeitado antes de tocar a Pagar.me', async () => {
      // Rejeita já na validação do instrumento (antes do gate de recebedor),
      // então só o lookup do listing é consumido.
      selectChain.where.mockResolvedValueOnce([fakeListingActive]); // listing

      await expect(
        service.createCheckout('user_buyer', {
          ...baseDto,
          paymentMethod: 'credit_card',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── Cancelamento manual + varredura de PIX expirado ────────────────────────
  describe('cancelOrder (manual)', () => {
    const pendingPixOrder = {
      id: 'order_123',
      buyerId: 'user_buyer',
      sellerId: 'user_seller',
      listingId: 'listing_001',
      status: 'pending',
      paymentInstrument: 'pix',
      pagarmeOrderId: 'or_test',
      walletAmountInCents: 0,
    };

    it('cancela o próprio pedido pendente e reativa o anúncio (não pago na Pagar.me)', async () => {
      mockPagarmeService.get.mockResolvedValueOnce({ id: 'or_test', status: 'failed' });
      selectChain.where
        .mockResolvedValueOnce([pendingPixOrder]) // fetch inicial
        .mockResolvedValueOnce([{ ...pendingPixOrder, status: 'cancelled' }]); // re-read

      const result = await service.cancelOrder('user_buyer', 'order_123');

      expect(mockPagarmeService.get).toHaveBeenCalledWith('/orders/or_test');
      // guard atômico: transiciona pending→cancelled
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'cancelled' }),
      );
      // reativa o anúncio
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' }),
      );
      expect(result.status).toBe('cancelled');
    });

    it('rejeita cancelar pedido de outro comprador', async () => {
      selectChain.where.mockResolvedValueOnce([pendingPixOrder]);
      await expect(
        service.cancelOrder('outro_user', 'order_123'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejeita cancelar pedido que não está pendente', async () => {
      selectChain.where.mockResolvedValueOnce([{ ...pendingPixOrder, status: 'paid' }]);
      await expect(
        service.cancelOrder('user_buyer', 'order_123'),
      ).rejects.toThrow(BadRequestException);
    });

    it('não cancela se a Pagar.me diz que já foi pago (confirma e recusa o cancelamento)', async () => {
      mockPagarmeService.get.mockResolvedValueOnce({
        id: 'or_test',
        status: 'paid',
        charges: [{ id: 'ch_test' }],
      });
      selectChain.where
        .mockResolvedValueOnce([pendingPixOrder]) // fetch inicial (cancelOrder)
        .mockResolvedValueOnce([pendingPixOrder]) // confirmOrderPayment: order (pending)
        .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com' }]) // buyer
        .mockResolvedValueOnce([{ title: 'Hot Wheels' }]); // listing

      await expect(
        service.cancelOrder('user_buyer', 'order_123'),
      ).rejects.toThrow(BadRequestException);

      // confirmou a venda (hold do vendedor) em vez de cancelar
      expect(mockWalletService.hold).toHaveBeenCalledTimes(1);
    });
  });

  describe('sweepExpiredPendingPix (cron)', () => {
    it('cancela pedido PIX pendente expirado (não pago na Pagar.me)', async () => {
      mockPagarmeService.get.mockResolvedValueOnce({ id: 'or_test', status: 'failed' });
      selectChain.where.mockResolvedValueOnce([
        {
          id: 'order_123',
          buyerId: 'user_buyer',
          listingId: 'listing_001',
          status: 'pending',
          paymentInstrument: 'pix',
          pagarmeOrderId: 'or_test',
          walletAmountInCents: 0,
        },
      ]);

      const r = await service.sweepExpiredPendingPix();

      expect(r.checked).toBe(1);
      expect(r.cancelled).toBe(1);
      expect(r.recovered).toBe(0);
    });

    it('não faz nada quando não há pedidos expirados', async () => {
      selectChain.where.mockResolvedValueOnce([]);
      const r = await service.sweepExpiredPendingPix();
      expect(r).toEqual({ checked: 0, cancelled: 0, recovered: 0 });
    });
  });

  // ── Queries enriquecidas (join com listing + contraparte) ──────────────────
  describe('findSellerOrders', () => {
    it('deve enriquecer pedidos com listing (imagens parseadas) e nome do comprador', async () => {
      selectChain.where.mockResolvedValueOnce([
        {
          order: { id: 'o1', buyerId: 'user_buyer', sellerId: 'user_seller', totalInCents: 50000, status: 'paid' },
          listingTitle: 'Hot Wheels RLC',
          listingImages: '["https://img/1.jpg","https://img/2.jpg"]',
          listingPrice: 50000,
          counterpartName: 'Lucas Mendes',
        },
      ]);

      const result = await service.findSellerOrders('user_seller');

      expect(selectChain.leftJoin).toHaveBeenCalledTimes(2);
      expect(result[0].listing).toEqual({
        title: 'Hot Wheels RLC',
        images: ['https://img/1.jpg', 'https://img/2.jpg'],
        priceInCents: 50000,
      });
      expect(result[0].buyer).toEqual({ id: 'user_buyer', name: 'Lucas Mendes' });
    });

    it('deve usar fallbacks quando listing/comprador ausentes', async () => {
      selectChain.where.mockResolvedValueOnce([
        {
          order: { id: 'o2', buyerId: 'user_x', sellerId: 'user_seller', totalInCents: 1000, status: 'paid' },
          listingTitle: null,
          listingImages: null,
          listingPrice: null,
          counterpartName: null,
        },
      ]);

      const result = await service.findSellerOrders('user_seller');

      expect(result[0].listing).toEqual({
        title: 'Item indisponível',
        images: [],
        priceInCents: 1000,
      });
      expect(result[0].buyer.name).toBe('Comprador');
    });
  });

  describe('findBuyerOrders', () => {
    it('deve enriquecer com listing e nome do vendedor', async () => {
      selectChain.where.mockResolvedValueOnce([
        {
          order: { id: 'o3', buyerId: 'user_buyer', sellerId: 'user_seller', totalInCents: 2000, status: 'paid' },
          listingTitle: 'Matchbox',
          listingImages: 'https://img/legacy.jpg',
          listingPrice: 2000,
          counterpartName: 'CardHouse',
        },
      ]);

      const result = await service.findBuyerOrders('user_buyer');

      // CSV legado também é parseado
      expect(result[0].listing.images).toEqual(['https://img/legacy.jpg']);
      expect(result[0].seller).toEqual({ id: 'user_seller', name: 'CardHouse' });
    });
  });
});
