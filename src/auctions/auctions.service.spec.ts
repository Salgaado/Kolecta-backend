/**
 * O cartão está FECHADO por padrão (`payment-flags.ts`) enquanto o antifraude
 * da Pagar.me reprova toda cobrança. Estes testes cobrem o cartão funcionando,
 * então ligam o interruptor antes do import — a flag é lida no carregamento do
 * módulo.
 */
process.env.PAGAMENTO_CARTAO_HABILITADO = 'true';
/**
 * Recebedor da plataforma. Sem ele, lance e pagamento de arremate são
 * RECUSADOS em vez de seguirem sem split (ver `docs/PLAN-pagarme-conta-nova.md`,
 * Fase 1). Lido no carregamento do módulo, por isso vem antes do import.
 */
process.env.PAGARME_PLATFORM_RECIPIENT_ID = 're_platform';

import { Test, TestingModule } from '@nestjs/testing';
import { AuctionsService } from './auctions.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { WalletService } from '../wallet/wallet.service';
import { FounderService } from '../founder/founder.service';
import { CardsService } from '../cards/cards.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { ShippingService } from '../shipping/shipping.service';
import { FreteSubsidioService } from '../shipping/frete-subsidio.service';
import { ConciliacaoService } from '../pagarme/conciliacao.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Emissor de eventos: só precisamos observar o que foi emitido.
const mockEventEmitter = { emit: jest.fn() };

/**
 * Cotação de frete. `raw.id` é o que identifica o serviço no Melhor Envio — e é
 * por ele que `chooseShipping` casa a escolha do comprador com o preço do
 * servidor. Opção sem `raw.id` é o mock que o ShippingService devolve quando a
 * API está fora, e o serviço tem que recusar.
 */
/**
 * Frete compartilhado. O default espelha a política DESLIGADA, que é como ela
 * vai ao ar: o comprador paga o frete cheio e a Kolecta não banca nada. Os
 * testes que exercitam o subsídio sobrescrevem com `mockResolvedValueOnce`.
 */
const mockFreteSubsidioService = {
  resolver: jest.fn(async ({ freteEscolhidoInCents }: any) => ({
    shippingInCents: freteEscolhidoInCents,
    shippingCostInCents: freteEscolhidoInCents,
    shippingSubsidyInCents: 0,
  })),
};

const mockShippingService = {
  quoteShipping: jest.fn().mockResolvedValue({
    pickup: true,
    options: [
      {
        carrier: 'Correios',
        service: 'PAC',
        price: 15.5,
        delivery_time_days: 7,
        raw: { id: 1 },
      },
      {
        carrier: 'Correios',
        service: 'SEDEX',
        price: 32.9,
        delivery_time_days: 2,
        raw: { id: 2 },
      },
    ],
  }),
};
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';

const mockWallet = {
  id: 'wallet_seller',
  userId: 'seller_001',
  balanceInCents: 0,
  pendingInCents: 0,
};

const mockWalletService = {
  getOrCreateWallet: jest.fn().mockResolvedValue(mockWallet),
  hold: jest.fn().mockResolvedValue({ success: true }),
};

const mockFounderService = {
  resolveCommissionPercent: jest.fn().mockResolvedValue(11),
};

// Cartão salvo do bidder (referência interna customer + card_id).
const mockCardsService = {
  getCardRef: jest
    .fn()
    .mockResolvedValue({ customerId: 'cus_1', cardId: 'card_1' }),
};

// Pré-auth padrão, na forma que a API REAL devolve (conferido em sandbox
// 30/07): a cobrança fica `pending` e quem carrega `authorized_pending_capture`
// é a TRANSAÇÃO. O mock antigo punha esse status na cobrança — forma que a
// Pagar.me nunca retorna, o que fazia o teste validar uma resposta imaginária.
const authorizedOrder = {
  id: 'or_1',
  status: 'pending',
  charges: [
    {
      id: 'ch_1',
      status: 'pending',
      last_transaction: { status: 'authorized_pending_capture' },
    },
  ],
};

/**
 * O portão antes do cancelamento por prazo: nenhum pedido é cancelado sem
 * perguntar à Pagar.me se foi pago. Default `nao-pago` — os testes que não
 * falam de conciliação seguem exercitando o cancelamento normal.
 */
const mockConciliacaoService = {
  conciliarPedido: jest.fn().mockResolvedValue({ acao: 'nao-pago' }),
};

const mockPagarmeService = {
  post: jest.fn().mockResolvedValue(authorizedOrder),
  delete: jest.fn().mockResolvedValue({}),
  // Consulta do estado real da retenção. Default: de pé — assim os testes que
  // não falam de retenção solta seguem exercitando só o caminho da validade.
  get: jest.fn().mockResolvedValue({
    status: 'pending',
    last_transaction: { status: 'authorized_pending_capture' },
  }),
};

const sellerId = 'seller_001';
const bidderId = 'buyer_001';
const mockListingId = 'listing_auction_001';
const mockAuctionId = 'auction_001';

const mockListing = {
  id: mockListingId,
  sellerId,
  type: 'auction',
  status: 'active',
  priceInCents: null,
};

const mockAuction = {
  id: mockAuctionId,
  listingId: mockListingId,
  startingBidInCents: 5000,
  minIncrementInCents: 1000,
  currentBidInCents: 5000,
  currentWinnerId: null,
  reservePriceInCents: null,
  durationHours: 48,
  endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
  antiSniper: true,
  status: 'active',
};

const mockBid = {
  id: 'bid_001',
  auctionId: mockAuctionId,
  bidderId,
  amountInCents: 6000,
  createdAt: new Date(),
};

// Builder de mock Drizzle com encadeamento completo
//
// Estratégia: `where` retorna `chain` por padrão para suportar o padrão
//   update().set().where().returning()
// e também select().from().innerJoin().where().orderBy().
// Testes que precisam de `where` como terminal usam mockResolvedValueOnce.
const makeDrizzleMock = () => {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain); // retorna chain por padrão
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  // Vendedor + perfil de loja entram por leftJoin (nome do vendedor no leilão).
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockResolvedValue([mockBid]);
  chain.groupBy = jest.fn().mockResolvedValue([]); // contagem de lances por leilão
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.offset = jest.fn().mockReturnValue(chain);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue([mockAuction]);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.set = jest.fn().mockReturnValue(chain);
  // Guarda cada tx: o insert do pedido acontece DENTRO da transação, então é
  // no tx (e não no chain) que ficam os valores a inspecionar.
  chain.txs = [] as any[];
  chain.transaction = jest.fn().mockImplementation(async (fn: any) => {
    const tx: any = {};
    tx.insert = jest.fn().mockReturnValue(tx);
    tx.values = jest.fn().mockReturnValue(tx);
    // returning() é usado tanto pelo insert do lance quanto pelo update-guard;
    // por padrão resolve não-vazio (lance registrado + update aplicado).
    tx.returning = jest.fn().mockResolvedValue([mockBid]);
    tx.update = jest.fn().mockReturnValue(tx);
    tx.set = jest.fn().mockReturnValue(tx);
    tx.where = jest.fn().mockReturnValue(tx);
    chain.txs.push(tx);
    return fn(tx);
  });
  return chain;
};

const mockEndereco = {
  id: 'addr_1',
  userId: 'user_bidder',
  street: 'Rua Teste',
  number: '100',
  complement: null,
  neighborhood: 'Centro',
  city: 'Sao Paulo',
  state: 'SP',
  zip: '01310-100',
  country: 'BR',
  isDefault: true,
};

describe('AuctionsService', () => {
  let service: AuctionsService;
  let mockDb: any;

  const buildModule = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuctionsService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
        { provide: WalletService, useValue: mockWalletService },
        { provide: FounderService, useValue: mockFounderService },
        { provide: CardsService, useValue: mockCardsService },
        { provide: PagarmeService, useValue: mockPagarmeService },
        { provide: ShippingService, useValue: mockShippingService },
        { provide: FreteSubsidioService, useValue: mockFreteSubsidioService },
        { provide: ConciliacaoService, useValue: mockConciliacaoService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    return module.get<AuctionsService>(AuctionsService);
  };

  beforeEach(() => {
    // Restaura defaults dos mocks compartilhados (evita vazamento de *Once).
    mockWalletService.getOrCreateWallet
      .mockReset()
      .mockResolvedValue(mockWallet);
    mockWalletService.hold.mockReset().mockResolvedValue({ success: true });
    mockFounderService.resolveCommissionPercent
      .mockReset()
      .mockResolvedValue(11);
    mockCardsService.getCardRef
      .mockReset()
      .mockResolvedValue({ customerId: 'cus_1', cardId: 'card_1' });
    mockPagarmeService.post.mockReset().mockResolvedValue(authorizedOrder);
    mockPagarmeService.delete.mockReset().mockResolvedValue({});
    mockFreteSubsidioService.resolver
      .mockReset()
      .mockImplementation(async ({ freteEscolhidoInCents }: any) => ({
        shippingInCents: freteEscolhidoInCents,
        shippingCostInCents: freteEscolhidoInCents,
        shippingSubsidyInCents: 0,
      }));
    mockShippingService.quoteShipping.mockReset().mockResolvedValue({
      pickup: true,
      options: [
        {
          carrier: 'Correios',
          service: 'PAC',
          price: 15.5,
          delivery_time_days: 7,
          raw: { id: 1 },
        },
        {
          carrier: 'Correios',
          service: 'SEDEX',
          price: 32.9,
          delivery_time_days: 2,
          raw: { id: 2 },
        },
      ],
    });
    mockEventEmitter.emit.mockReset();
  });

  // ── findById ─────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('deve lançar NotFoundException se leilão não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();

      await expect(service.findById('nope')).rejects.toThrow(NotFoundException);
    });

    it('deve retornar o leilão encontrado', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([mockAuction]);
      service = await buildModule();

      const result = await service.findById(mockAuctionId);
      expect(result).toEqual(mockAuction);
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('deve lançar NotFoundException se listing não pertence ao seller', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();

      await expect(
        service.create(sellerId, {
          listingId: mockListingId,
          startingBidInCents: 5000,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar BadRequestException se listing não é do tipo auction', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...mockListing, type: 'direct' }]);
      service = await buildModule();

      await expect(
        service.create(sellerId, {
          listingId: mockListingId,
          startingBidInCents: 5000,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── placeBid ──────────────────────────────────────────────────────────────

  describe('placeBid', () => {
    it('deve lançar NotFoundException se leilão não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();

      await expect(
        service.placeBid('nope', bidderId, { amountInCents: 6000 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar ForbiddenException se bidder é o seller do listing', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction]) // auction found
        .mockResolvedValueOnce([mockListing]); // listing with same sellerId
      service = await buildModule();

      await expect(
        service.placeBid(mockAuctionId, sellerId, { amountInCents: 6000 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deve lançar BadRequestException se lance é menor que o mínimo', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction]) // auction
        .mockResolvedValueOnce([
          { ...mockListing, sellerId: 'another_seller' },
        ]); // listing different seller
      service = await buildModule();

      await expect(
        // currentBid=5000, minIncrement=1000 → mínimo=6001, tentando 5000
        service.placeBid(mockAuctionId, bidderId, { amountInCents: 5000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deve lançar BadRequestException se o bidder não tem cartão salvo', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([
          { ...mockListing, sellerId: 'another_seller' },
        ]);
      mockCardsService.getCardRef.mockReset().mockResolvedValue(null);
      service = await buildModule();

      await expect(
        service.placeBid(mockAuctionId, bidderId, { amountInCents: 6100 }),
      ).rejects.toThrow(BadRequestException);
      // Sem cartão → nem tenta autorizar na Pagar.me.
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('deve lançar BadRequestException se o cartão é recusado na pré-auth', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança do bidder
      mockPagarmeService.post.mockReset().mockResolvedValue({
        id: 'or_x',
        status: 'failed',
        charges: [{ id: 'ch_x', status: 'failed' }],
      });
      service = await buildModule();

      await expect(
        service.placeBid(mockAuctionId, bidderId, { amountInCents: 6100 }),
      ).rejects.toThrow(BadRequestException);
    });

    /**
     * O lance sofria do mesmo ponto cego que travou o arremate: o motivo era
     * lido só na forma de LISTA, e num erro de VALIDAÇÃO a Pagar.me indexa
     * `errors` pelo campo. A mensagem degradava para o `message` do nosso
     * embrulho — "Erro na comunicação com a Pagar.me" —, que sugere falha de
     * rede e manda a pessoa tentar de novo num erro que nunca é transitório.
     */
    it('entrega o motivo REAL quando a Pagar.me invalida o request do lance', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([mockEndereco]);
      mockPagarmeService.post.mockReset().mockRejectedValue({
        response: {
          message: 'Erro na comunicação com a Pagar.me',
          pagarme: {
            message: 'The request is invalid.',
            errors: { 'customer.document': ['"document" is required'] },
          },
        },
      });
      service = await buildModule();

      await expect(
        service.placeBid(mockAuctionId, bidderId, { amountInCents: 6100 }),
      ).rejects.toThrow('customer.document: "document" is required');
    });

    it('deve registrar lance com sucesso (pré-auth no cartão)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança do bidder
      service = await buildModule();

      const result = await service.placeBid(mockAuctionId, bidderId, {
        amountInCents: 6100, // > 5000 + 1000
      });

      expect(result).toEqual(mockBid);
      // Criou a pré-autorização (capture:false) na Pagar.me.
      expect(mockPagarmeService.post).toHaveBeenCalledWith(
        '/orders',
        expect.objectContaining({
          customer_id: 'cus_1',
          payments: expect.arrayContaining([
            expect.objectContaining({
              credit_card: expect.objectContaining({
                capture: false,
                card_id: 'card_1',
              }),
            }),
          ]),
        }),
        expect.any(String),
      );
    });

    it('deve lançar ConflictException e cancelar a pré-auth se perder a corrida', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction])
        .mockResolvedValueOnce([{ ...mockListing, sellerId: 'another_seller' }])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança do bidder

      // Transaction em que o UPDATE condicional não afeta linhas (returning vazio),
      // simulando que um lance igual/maior chegou primeiro.
      mockDb.transaction = jest.fn().mockImplementation(async (fn: any) => {
        const tx: any = {};
        tx.insert = jest.fn().mockReturnValue(tx);
        tx.values = jest.fn().mockReturnValue(tx);
        tx.update = jest.fn().mockReturnValue(tx);
        tx.set = jest.fn().mockReturnValue(tx);
        tx.where = jest.fn().mockReturnValue(tx);
        // 1ª chamada (insert do lance) → não-vazio; 2ª (update-guard) → vazio
        tx.returning = jest
          .fn()
          .mockResolvedValueOnce([mockBid])
          .mockResolvedValueOnce([]);
        return fn(tx);
      });

      service = await buildModule();

      await expect(
        service.placeBid(mockAuctionId, bidderId, { amountInCents: 6100 }),
      ).rejects.toThrow(ConflictException);
      // Rollback: a pré-auth recém-criada é cancelada (void).
      expect(mockPagarmeService.delete).toHaveBeenCalledWith('/charges/ch_1');
    });
  });

  // ── findSellerAuctions ────────────────────────────────────────────────────

  describe('findSellerAuctions', () => {
    it('deve retornar array de leilões do seller', async () => {
      const sellerAuction = { ...mockAuction, sellerId };
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([sellerAuction]);
      service = await buildModule();

      const result = await service.findSellerAuctions(sellerId);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
    });

    it('deve chamar innerJoin para buscar dados do listing', async () => {
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([]);
      service = await buildModule();

      await service.findSellerAuctions(sellerId);

      expect(mockDb.innerJoin).toHaveBeenCalled();
    });

    it('deve retornar array vazio se o seller não tem leilões', async () => {
      mockDb = makeDrizzleMock();
      mockDb.orderBy.mockResolvedValue([]);
      service = await buildModule();

      const result = await service.findSellerAuctions('seller_sem_leiloes');

      expect(result).toEqual([]);
    });
  });

  // ── endAuction ────────────────────────────────────────────────────────────

  /**
   * O leilão não passa por checkout, então o pedido nascia sem endereço e a
   * etiqueta do Melhor Envio nem chegava a ser pedida ("Pedido sem endereço de
   * entrega"). O endereço agora vem do cadastro do vencedor.
   */
  describe('_getDefaultAddressId', () => {
    const chamar = async (enderecos: any[]) => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce(enderecos);
      service = await buildModule();
      return (service as any)._getDefaultAddressId('user_1');
    };

    it('prefere o endereço marcado como padrão', async () => {
      await expect(
        chamar([
          { id: 'end_a', isDefault: false },
          { id: 'end_b', isDefault: true },
        ]),
      ).resolves.toBe('end_b');
    });

    it('cai no primeiro quando nenhum é padrão', async () => {
      await expect(chamar([{ id: 'end_a', isDefault: false }])).resolves.toBe(
        'end_a',
      );
    });

    it('devolve null quando o usuário não tem endereço', async () => {
      await expect(chamar([])).resolves.toBeNull();
    });
  });

  describe('endAuction', () => {
    it('deve lançar NotFoundException se leilão não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // auction não encontrado
      service = await buildModule();

      await expect(
        service.endAuction('auction_nope', sellerId),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar BadRequestException se leilão não está ativo', async () => {
      const endedAuction = { ...mockAuction, status: 'ended' };
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([endedAuction]);
      service = await buildModule();

      await expect(service.endAuction(mockAuctionId, sellerId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('deve lançar ForbiddenException se requester não é seller nem admin', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction]) // auction ativo
        .mockResolvedValueOnce([mockListing]) // listing com sellerId diferente
        .mockResolvedValueOnce([{ id: 'outro_user', role: 'user' }]); // requester não é admin
      service = await buildModule();

      await expect(
        service.endAuction(mockAuctionId, 'outro_user'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deve encerrar o leilão quando o requester é o seller (sem vencedor)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction]) // auction ativo (sem vencedor)
        .mockResolvedValueOnce([mockListing]) // listing pertence ao seller
        .mockResolvedValueOnce([{ id: sellerId, role: 'user' }]); // requester é o seller
      service = await buildModule();

      // Leilão sem vencedor → _closeAuction encerra via db.update (sem tx).
      await expect(
        service.endAuction(mockAuctionId, sellerId),
      ).resolves.not.toThrow();

      expect(mockDb.update).toHaveBeenCalled();
    });

    it('deve encerrar o leilão quando o requester é admin', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([mockAuction]) // auction ativo
        .mockResolvedValueOnce([mockListing]) // listing (seller diferente)
        .mockResolvedValueOnce([{ id: 'admin_user', role: 'admin' }]); // requester é admin
      service = await buildModule();

      await expect(
        service.endAuction(mockAuctionId, 'admin_user'),
      ).resolves.not.toThrow();

      expect(mockDb.update).toHaveBeenCalled();
    });

    /**
     * O fecho NÃO cobra mais nada.
     *
     * O lance cobre só a peça; o frete é escolhido pelo vencedor depois e entra
     * no MESMO total. Como não se captura acima do valor autorizado, capturar
     * aqui obrigaria a uma segunda cobrança só do frete. O pedido nasce
     * `pending_payment` e a pré-auth vira garantia.
     */
    const fecharComVencedor = async () => {
      const winnerAuction = {
        ...mockAuction,
        currentWinnerId: bidderId,
        currentBidInCents: 6000,
      };
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([winnerAuction]) // auction (com vencedor)
        .mockResolvedValueOnce([mockListing]) // listing
        .mockResolvedValueOnce([{ id: sellerId, role: 'user' }]) // requester = seller
        .mockResolvedValueOnce([{ chargeId: 'ch_1', orderId: 'or_1' }]) // _getActiveBidAuth
        .mockResolvedValueOnce([{ id: 'end_1', isDefault: true }]); // endereço do vencedor
      service = await buildModule();
      await service.endAuction(mockAuctionId, sellerId);
      return mockDb.txs
        .flatMap((tx: any) => tx.values.mock.calls)
        .map((c: any[]) => c[0])
        .find((v: any) => v?.buyerId === bidderId);
    };

    it('NÃO captura a pré-auth no fecho: pedido nasce pending_payment sem frete', async () => {
      const pedido = await fecharComVencedor();

      // Nada de captura — o total ainda vai crescer com o frete.
      expect(mockPagarmeService.post).not.toHaveBeenCalledWith(
        expect.stringContaining('/capture'),
        expect.anything(),
        expect.anything(),
      );
      expect(pedido?.status).toBe('pending_payment');
      expect(pedido?.totalInCents).toBe(6000);
      expect(pedido?.shippingInCents).toBe(0);
      // O pedido nasce COM endereço: é dele que sai a cotação do frete.
      expect(pedido?.addressId).toBe('end_1');
      // Sem cobrança não há líquido a reter ainda.
      expect(mockWalletService.hold).not.toHaveBeenCalled();
    });

    it('mantém a pré-auth de pé no fecho (é a garantia enquanto ele escolhe)', async () => {
      await fecharComVencedor();

      // Cancelar aqui deixaria o arremate sem garantia nenhuma até o pagamento.
      expect(mockPagarmeService.delete).not.toHaveBeenCalled();
    });

    it('avisa o vencedor que falta escolher o frete', async () => {
      await fecharComVencedor();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'auction.won',
        expect.objectContaining({
          winnerId: bidderId,
          needsPayment: true,
          needsShippingChoice: true,
        }),
      );
    });
  });

  // ── endExpiredAuctions ────────────────────────────────────────────────────

  describe('endExpiredAuctions', () => {
    it('deve retornar array vazio se não há leilões expirados', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // nenhum leilão expirado
      service = await buildModule();

      const result = await service.endExpiredAuctions();

      expect(result).toEqual([]);
    });

    it('deve retornar IDs dos leilões que foram fechados', async () => {
      const expiredAuction = {
        ...mockAuction,
        id: 'auction_expired',
        endsAt: new Date(Date.now() - 1000), // já expirou
      };
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([expiredAuction]) // leilões expirados
        .mockResolvedValueOnce([mockListing]); // listing do leilão expirado
      service = await buildModule();

      const result = await service.endExpiredAuctions();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toContain('auction_expired');
    });

    it('deve continuar processando mesmo se um leilão falhar', async () => {
      const expiredAuction1 = {
        ...mockAuction,
        id: 'auction_exp_1',
        endsAt: new Date(Date.now() - 1000),
      };
      const expiredAuction2 = {
        ...mockAuction,
        id: 'auction_exp_2',
        endsAt: new Date(Date.now() - 2000),
      };
      mockDb = makeDrizzleMock();
      // Retorna 2 expirados
      mockDb.where
        .mockResolvedValueOnce([expiredAuction1, expiredAuction2])
        .mockResolvedValueOnce([mockListing]) // listing para o primeiro
        .mockResolvedValueOnce([mockListing]); // listing para o segundo

      service = await buildModule();
      // Falha só no fechamento do 1º leilão (resolveCommissionPercent é o
      // primeiro await de _closeAuction) → deve ser capturada e seguir p/ o 2º.
      mockFounderService.resolveCommissionPercent
        .mockReset()
        .mockRejectedValueOnce(new Error('Falha simulada'))
        .mockResolvedValue(11);

      const result = await service.endExpiredAuctions();

      // Só o segundo deve ter sido fechado com sucesso
      expect(result).toContain('auction_exp_2');
      expect(result).not.toContain('auction_exp_1');
    });
  });

  // ── Retomada automática ao vendedor ficar apto ───────────────────────────
  //
  // Na migração para a conta nova (31/07/2026) os 110 leilões foram pausados:
  // sem recebedor ativo o lance é recusado, e leilão visível onde ninguém
  // consegue dar lance é pior que leilão fora do ar — o comprador culpa a
  // plataforma e o vendedor perde a venda sem saber por quê. Conforme cada um
  // refaz o cadastro, os leilões dele voltam sozinhos.

  describe('retomarLeiloesDoVendedor', () => {
    it('devolve o leilão com o tempo que FALTAVA, não com o relógio corrido', async () => {
      mockDb = makeDrizzleMock();
      const doisDiasMs = 2 * 24 * 60 * 60 * 1000;
      mockDb.where.mockResolvedValueOnce([
        { id: 'auction_1', restanteMs: doisDiasMs },
      ]);
      service = await buildModule();

      const antes = Date.now();
      const total = await service.retomarLeiloesDoVendedor({
        sellerId: 'user_seller',
      });

      expect(total).toBe(1);
      const patch = mockDb.set.mock.calls[0][0];
      expect(patch.pausedAt).toBeNull();
      expect(patch.pausedRemainingMs).toBeNull();
      // Novo fim ≈ agora + o que faltava (folga de 5s para o relógio do teste).
      const esperado = antes + doisDiasMs;
      expect(
        Math.abs(new Date(patch.endsAt).getTime() - esperado),
      ).toBeLessThan(5000);
    });

    it('não faz nada quando o vendedor não tem leilão pausado', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();

      const total = await service.retomarLeiloesDoVendedor({
        sellerId: 'user_seller',
      });

      // Idempotência: `recipient.updated` chega várias vezes para o mesmo
      // vendedor, e a segunda não pode reiniciar relógio de leilão já no ar.
      expect(total).toBe(0);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  // ── reauthorizeExpiringBids (Fase 3) ─────────────────────────────────────

  describe('reauthorizeExpiringBids', () => {
    // Vence daqui a 1h: dentro da janela de renovação (24h), que é o caminho
    // pela DATA. O caminho por VERIFICAÇÃO usa `reauthRowLonge`, abaixo.
    const reauthRow = {
      bidId: 'bid_001',
      auctionId: mockAuctionId,
      bidderId,
      amountInCents: 6000,
      chargeId: 'ch_old',
      authExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      sellerId,
    };

    /** Mesmo lance, mas com validade longe: só renova se a retenção sumiu. */
    const reauthRowLonge = {
      ...reauthRow,
      authExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    };

    it('não faz nada quando não há pré-auth a expirar', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // nenhum lance na janela
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result).toEqual({ reauthorized: [], failed: [] });
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('renova a pré-auth: cria uma nova e cancela a antiga', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([reauthRow]) // lances líderes a expirar
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança do bidder
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result.reauthorized).toContain('bid_001');
      expect(result.failed).toEqual([]);
      // Criou nova pré-auth (capture:false).
      expect(mockPagarmeService.post).toHaveBeenCalledWith(
        '/orders',
        expect.objectContaining({
          payments: expect.arrayContaining([
            expect.objectContaining({
              credit_card: expect.objectContaining({ capture: false }),
            }),
          ]),
        }),
        expect.any(String),
      );
      // Cancelou a auth ANTIGA.
      expect(mockPagarmeService.delete).toHaveBeenCalledWith('/charges/ch_old');
    });

    it('pula (sem renovar) quando o bidder não tem mais cartão salvo', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([reauthRow]);
      mockCardsService.getCardRef.mockReset().mockResolvedValue(null);
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result.reauthorized).toEqual([]);
      expect(result.failed).toEqual([]);
      // Sem cartão → não tenta autorizar nem cancela a auth antiga.
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
      expect(mockPagarmeService.delete).not.toHaveBeenCalled();
    });

    it('desfaz a auth NOVA e não conta como renovada se o lance mudou no meio', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([reauthRow])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança
      // Troca atômica não afeta linhas (lance superado/fechado no meio).
      mockDb.returning.mockResolvedValueOnce([]);
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result.reauthorized).toEqual([]);
      // Rollback: cancela a auth NOVA (ch_1 do authorizedOrder), não a antiga.
      expect(mockPagarmeService.delete).toHaveBeenCalledWith('/charges/ch_1');
      expect(mockPagarmeService.delete).not.toHaveBeenCalledWith(
        '/charges/ch_old',
      );
    });

    it('marca como falha e MANTÉM a auth antiga se o cartão é recusado agora', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([reauthRow])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([mockEndereco]); // endereço de cobrança
      // Cartão recusado na renovação.
      mockPagarmeService.post.mockReset().mockResolvedValue({
        id: 'or_x',
        status: 'failed',
        charges: [{ id: 'ch_x', status: 'failed' }],
      });
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result.failed).toContain('bid_001');
      expect(result.reauthorized).toEqual([]);
      // A auth ANTIGA é preservada (degrada para pending_payment no fecho).
      expect(mockPagarmeService.delete).not.toHaveBeenCalledWith(
        '/charges/ch_old',
      );
    });

    // ── Retenção devolvida antes do prazo ──────────────────────────────────
    //
    // `authExpiresAt` é estimativa nossa. Bandeira e banco emissor às vezes
    // liberam o saldo antes do prazo contratado e não avisam ninguém. Confiar
    // só na data faz a plataforma acreditar numa garantia inexistente até a
    // hora de capturar — com o leilão fechado e o vencedor já avisado.

    it('renova quando a retenção sumiu, mesmo com a validade longe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([reauthRowLonge])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([mockEndereco]);
      // O banco devolveu o saldo: a transação não está mais retida.
      mockPagarmeService.get.mockResolvedValueOnce({
        status: 'canceled',
        last_transaction: { status: 'voided' },
      });
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result.reauthorized).toContain('bid_001');
      expect(mockPagarmeService.get).toHaveBeenCalledWith('/charges/ch_old');
    });

    it('não renova quando a retenção segue de pé e a validade está longe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([reauthRowLonge]);
      mockPagarmeService.get.mockResolvedValueOnce({
        status: 'pending',
        last_transaction: { status: 'authorized_pending_capture' },
      });
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      expect(result).toEqual({ reauthorized: [], failed: [] });
      // Renovar à toa criaria uma SEGUNDA retenção no limite do comprador.
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('na dúvida (consulta falhou) NÃO renova — trata como retida', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([reauthRowLonge]);
      mockPagarmeService.get.mockRejectedValueOnce(
        new Error('502 bad gateway'),
      );
      service = await buildModule();

      const result = await service.reauthorizeExpiringBids();

      // Uma instabilidade do gateway não pode bloquear o limite de todos os
      // líderes de uma vez: dúvida degrada para o comportamento anterior.
      expect(result).toEqual({ reauthorized: [], failed: [] });
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('não gasta consulta com quem já vai renovar pela data', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([reauthRow]) // vence em 1h
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([mockEndereco]);
      service = await buildModule();
      mockPagarmeService.get.mockClear(); // o mock é compartilhado entre casos

      await service.reauthorizeExpiringBids();

      expect(mockPagarmeService.get).not.toHaveBeenCalled();
    });
  });

  // ── Frete do arremate (escolhido pelo vencedor, depois do fecho) ─────────

  describe('getAuctionShippingOptions / chooseShipping', () => {
    // Arremate recém-fechado: total = só o lance, sem frete, sem escolha.
    const arremate = {
      id: 'order_1',
      buyerId: bidderId,
      sellerId,
      listingId: mockListingId,
      addressId: 'addr_1',
      totalInCents: 6000,
      shippingInCents: 0,
      shippingServiceId: null,
      shippingServiceName: null,
      deliveryMethod: 'shipping',
      sellerNetInCents: 5340,
      platformFeeInCents: 660,
      status: 'pending_payment',
      paymentDeadlineAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    };

    // `db.query.addresses.findFirst` é caminho separado do chain de select.
    const stubQuery = (endereco: any = mockEndereco) => {
      mockDb.query = {
        addresses: { findFirst: jest.fn().mockResolvedValue(endereco) },
      };
    };

    it('lista as opções com o total (lance + frete) de cada uma', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      service = await buildModule();

      const r = await service.getAuctionShippingOptions(bidderId, 'order_1');

      expect(r.bidInCents).toBe(6000);
      expect(r.needsAddress).toBe(false);
      // Ordenadas da mais barata para a mais cara.
      expect(r.options.map((o: any) => o.serviceId)).toEqual([1, 2]);
      expect(r.options[0]).toMatchObject({
        name: 'Correios PAC',
        shippingInCents: 1550,
        totalInCents: 7550,
      });
    });

    it('descarta opção sem raw.id (mock do ShippingService com o ME fora)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      mockShippingService.quoteShipping.mockResolvedValueOnce({
        pickup: true,
        options: [
          { carrier: 'Correios', service: 'PAC', price: 25.9, raw: {} },
        ],
      });
      service = await buildModule();

      const r = await service.getAuctionShippingOptions(bidderId, 'order_1');

      // Cobrar um preço que não corresponde a serviço nenhum faria a etiqueta
      // sair por outro valor — melhor não oferecer.
      expect(r.options).toEqual([]);
    });

    it('sinaliza needsAddress quando o vencedor não tem endereço', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...arremate, addressId: null }]);
      stubQuery(null);
      service = await buildModule();

      const r = await service.getAuctionShippingOptions(bidderId, 'order_1');

      expect(r.needsAddress).toBe(true);
      expect(r.options).toEqual([]);
      expect(mockShippingService.quoteShipping).not.toHaveBeenCalled();
    });

    it('soma o frete ao total e manda o frete INTEIRO para a plataforma', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      service = await buildModule();

      const r = await service.chooseShipping(bidderId, 'order_1', {
        deliveryMethod: 'shipping',
        shippingServiceId: 1,
      });

      expect(r).toMatchObject({
        bidInCents: 6000,
        shippingInCents: 1550,
        totalInCents: 7550,
        shippingServiceName: 'Correios PAC',
      });
      const gravado = mockDb.set.mock.calls[0][0];
      expect(gravado.totalInCents).toBe(7550);
      expect(gravado.externalAmountInCents).toBe(7550);
      // Comissão (660, sobre o item) + frete inteiro (1550). O líquido do
      // vendedor não muda com o frete.
      expect(gravado.platformFeeInCents).toBe(2210);
      expect(gravado.shippingServiceId).toBe(1);
    });

    /**
     * Frete compartilhado no leilão.
     *
     * O arremate só tem preço no fim, então o subsídio é decidido AQUI — e é
     * por isso que a página do leilão nunca promete "frete grátis", no máximo
     * "frete grátis se arrematar acima de R$ X".
     */
    describe('frete compartilhado', () => {
      it('desconta o subsídio do frete cobrado e grava as três colunas', async () => {
        mockDb = makeDrizzleMock();
        mockDb.where.mockResolvedValueOnce([arremate]);
        stubQuery();
        mockFreteSubsidioService.resolver.mockResolvedValueOnce({
          shippingInCents: 1150,
          shippingCostInCents: 1550,
          shippingSubsidyInCents: 400,
        });
        service = await buildModule();

        const r = await service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 1,
        });

        expect(r.shippingInCents).toBe(1150);
        expect(r.totalInCents).toBe(6000 + 1150);

        const gravado = mockDb.set.mock.calls[0][0];
        expect(gravado.shippingInCents).toBe(1150);
        expect(gravado.shippingCostInCents).toBe(1550);
        expect(gravado.shippingSubsidyInCents).toBe(400);
        // A invariante das colunas.
        expect(gravado.shippingCostInCents).toBe(
          gravado.shippingInCents + gravado.shippingSubsidyInCents,
        );
        // E a do split: comissão (660) + o frete que o comprador pagou.
        expect(gravado.platformFeeInCents).toBe(660 + 1150);
      });

      it('a âncora é a opção mais barata da rota, não a escolhida', async () => {
        mockDb = makeDrizzleMock();
        mockDb.where.mockResolvedValueOnce([arremate]);
        stubQuery();
        service = await buildModule();

        // Vencedor escolhe SEDEX (3290), mas a cotação tem PAC a 1550.
        await service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 2,
        });

        expect(mockFreteSubsidioService.resolver).toHaveBeenCalledWith(
          expect.objectContaining({
            itemInCents: 6000,
            freteEscolhidoInCents: 3290,
            // As duas opções da rota — quem escolhe a âncora é o serviço.
            opcoesEmCentavos: expect.arrayContaining([1550, 3290]),
          }),
        );
      });

      it('retirada em mãos: sem frete, sem custo, sem subsídio', async () => {
        mockDb = makeDrizzleMock();
        mockDb.where
          .mockResolvedValueOnce([arremate])
          .mockResolvedValueOnce([{ acceptsPickup: true }]);
        stubQuery();
        service = await buildModule();

        await service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'pickup',
        });

        const gravado = mockDb.set.mock.calls[0][0];
        expect(gravado.shippingInCents).toBe(0);
        expect(gravado.shippingCostInCents).toBe(0);
        expect(gravado.shippingSubsidyInCents).toBe(0);
        expect(mockFreteSubsidioService.resolver).not.toHaveBeenCalled();
      });
    });

    it('IGNORA preço vindo do cliente: usa o da recotagem no servidor', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      service = await buildModule();

      // O corpo não tem campo de preço; mesmo assim vale conferir que o valor
      // gravado veio da cotação, e não de nada que o comprador controle.
      const r = await service.chooseShipping(bidderId, 'order_1', {
        deliveryMethod: 'shipping',
        shippingServiceId: 2,
      } as any);

      expect(r.shippingInCents).toBe(3290); // SEDEX da cotação, não 0
      expect(r.totalInCents).toBe(9290);
    });

    it('recusa serviço que não está mais na cotação do endereço', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 999,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('é idempotente: trocar de opção não acumula frete sobre frete', async () => {
      // Pedido que JÁ tem SEDEX escolhido; agora ele troca para PAC.
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([
        {
          ...arremate,
          totalInCents: 9290, // 6000 + 3290
          shippingInCents: 3290,
          shippingServiceId: 2,
          shippingServiceName: 'Correios SEDEX',
          platformFeeInCents: 3950, // 660 + 3290
        },
      ]);
      stubQuery();
      service = await buildModule();

      const r = await service.chooseShipping(bidderId, 'order_1', {
        deliveryMethod: 'shipping',
        shippingServiceId: 1,
      });

      // Volta a partir do LANCE, não do total anterior.
      expect(r.bidInCents).toBe(6000);
      expect(r.totalInCents).toBe(7550);
      expect(mockDb.set.mock.calls[0][0].platformFeeInCents).toBe(2210);
    });

    it('retirada em mãos zera o frete e mantém o total no valor do lance', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([arremate])
        .mockResolvedValueOnce([{ acceptsPickup: true }]);
      stubQuery();
      service = await buildModule();

      const r = await service.chooseShipping(bidderId, 'order_1', {
        deliveryMethod: 'pickup',
      });

      expect(r).toMatchObject({
        deliveryMethod: 'pickup',
        shippingInCents: 0,
        totalInCents: 6000,
      });
      expect(mockDb.set.mock.calls[0][0].shippingServiceId).toBeNull();
    });

    it('recusa retirada em mãos quando o vendedor não aceita', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([arremate])
        .mockResolvedValueOnce([{ acceptsPickup: false }]);
      stubQuery();
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'pickup',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('recusa escolha de frete de outro comprador', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...arremate, buyerId: 'outro' }]);
      stubQuery();
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 1,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('recusa escolha depois do prazo vencido', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([
        { ...arremate, paymentDeadlineAt: new Date(Date.now() - 1000) },
      ]);
      stubQuery();
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    /**
     * O cron de expiração pode cancelar o pedido entre a leitura e a escrita.
     * Sem esta guarda o front seguia direto para a cobrança de um pedido morto,
     * e o vencedor via "cartão recusado" em vez do motivo real.
     */
    it('avisa quando o prazo vence no meio da escolha (update pega 0 linhas)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery();
      // update().set().where().returning() → nenhuma linha afetada.
      mockDb.set = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      });
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('recusa endereço que não pertence ao comprador', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([arremate]);
      stubQuery({ ...mockEndereco, id: 'addr_9', userId: 'outro_user' });
      service = await buildModule();

      await expect(
        service.chooseShipping(bidderId, 'order_1', {
          deliveryMethod: 'shipping',
          shippingServiceId: 1,
          addressId: 'addr_9',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── payAuctionOrder (Fase 4) ─────────────────────────────────────────────

  describe('payAuctionOrder', () => {
    // Pedido com a entrega JÁ escolhida — é o único estado em que pagar é
    // legal. Lance 6000 + frete 1550: o total é o que vai ao cartão, e a parte
    // da plataforma leva o frete inteiro (660 de comissão + 1550).
    const pendingOrder = {
      id: 'order_1',
      buyerId: bidderId,
      sellerId,
      listingId: mockListingId,
      totalInCents: 7550,
      shippingInCents: 1550,
      shippingServiceId: 1,
      shippingServiceName: 'Correios PAC',
      deliveryMethod: 'shipping',
      sellerNetInCents: 5340,
      platformFeeInCents: 2210,
      status: 'pending_payment',
      paymentDeadlineAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    };
    const paidOrder = {
      id: 'or_paid',
      status: 'paid',
      charges: [{ id: 'ch_paid', status: 'paid' }],
    };

    it('lança NotFound se o pedido não existe', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();
      await expect(service.payAuctionOrder(bidderId, 'nope')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lança Forbidden se o pedido é de outro comprador', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...pendingOrder, buyerId: 'x' }]);
      service = await buildModule();
      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lança BadRequest se o pedido não está pending_payment', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...pendingOrder, status: 'paid' }]);
      service = await buildModule();
      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('lança BadRequest se o prazo de pagamento expirou', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([
        { ...pendingOrder, paymentDeadlineAt: new Date(Date.now() - 1000) },
      ]);
      service = await buildModule();
      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('lança BadRequest se o comprador não tem cartão salvo', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([pendingOrder]);
      mockCardsService.getCardRef.mockReset().mockResolvedValue(null);
      service = await buildModule();
      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('lança BadRequest e NÃO consolida se o cartão é recusado', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([pendingOrder])
        .mockResolvedValueOnce([mockEndereco]) // endereço de cobrança
        // Sem leilao localizado => sem retencao: cai no fallback de cobrar o total.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([{ title: 'Hot Wheels Sam Walton' }]); // anúncio
      mockPagarmeService.post.mockReset().mockResolvedValue({
        id: 'or_x',
        status: 'failed',
        charges: [{ id: 'ch_x', status: 'failed' }],
      });
      service = await buildModule();
      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockWalletService.hold).not.toHaveBeenCalled();
    });

    /**
     * Sem escolha de entrega o total ainda é só o lance. Cobrar aí deixaria a
     * Kolecta pagando a etiqueta — que é exatamente o buraco que este fluxo
     * fecha.
     */
    it('RECUSA pagar enquanto o vencedor não escolheu a entrega', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([
        {
          ...pendingOrder,
          totalInCents: 6000,
          shippingInCents: 0,
          shippingServiceId: null,
          shippingServiceName: null,
          deliveryMethod: 'shipping', // default do schema, não é escolha
        },
      ]);
      service = await buildModule();

      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
    });

    it('aceita pagar quando a escolha foi RETIRADA em mãos (sem serviço de frete)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([
          {
            ...pendingOrder,
            totalInCents: 6000,
            shippingInCents: 0,
            shippingServiceId: null,
            shippingServiceName: null,
            deliveryMethod: 'pickup',
          },
        ])
        // Endereço de cobrança: vem do CADASTRO, não do pedido — na retirada
        // em mãos não há endereço de entrega e o cartão exige um do mesmo jeito.
        .mockResolvedValueOnce([mockEndereco])
        // Sem leilao localizado => sem retencao: cai no fallback de cobrar o total.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // auction (p/ ler a auth)
        .mockResolvedValueOnce([]) // _getActiveBidAuth: sem auth
        .mockResolvedValueOnce([{ id: 'auction_1' }]); // _settle
      mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
      service = await buildModule();

      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).resolves.toEqual({ orderId: 'order_1', paid: true });
    });

    it('paga com sucesso: cobra lance + frete, retém o líquido e LIBERA a pré-auth', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([pendingOrder]) // order
        .mockResolvedValueOnce([mockEndereco]) // endereço de cobrança
        // Sem leilao localizado => sem retencao: cai no fallback de cobrar o total.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }]) // sellerProfiles → vendedor apto
        .mockResolvedValueOnce([{ title: 'Hot Wheels Sam Walton' }]) // anúncio
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // auction por listingId
        .mockResolvedValueOnce([{ chargeId: 'ch_bid', orderId: 'or_bid' }]) // pré-auth do lance: LIDA ANTES do settle
        .mockResolvedValueOnce([{ id: 'auction_1' }]); // auction por listingId (_settle)
      mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
      service = await buildModule();

      const result = await service.payAuctionOrder(bidderId, 'order_1');

      expect(result).toEqual({ orderId: 'order_1', paid: true });
      // Cobrança com captura imediata (capture:true), não pré-auth, e no TOTAL
      // com frete — não no valor do lance. Os itens vão DISCRIMINADOS (peça e
      // frete em linhas separadas, com o título real do anúncio), e a soma
      // deles tem que bater com os 7550 cobrados.
      const corpo = mockPagarmeService.post.mock.calls[0][1];
      expect(corpo.items).toEqual([
        {
          amount: 6000,
          description: 'Hot Wheels Sam Walton',
          quantity: 1,
          code: mockListingId,
        },
        { amount: 1550, description: 'Frete', quantity: 1, code: 'frete' },
      ]);
      expect(corpo.items.reduce((t: number, i: any) => t + i.amount, 0)).toBe(
        7550,
      );
      expect(corpo.payments[0].credit_card.capture).toBe(true);
      // Líquido do vendedor retido na wallet.
      expect(mockWalletService.hold).toHaveBeenCalled();
      // A retenção do lance cai só DEPOIS da cobrança passar.
      expect(mockPagarmeService.delete).toHaveBeenCalledWith('/charges/ch_bid');
      // Etiqueta só é acionada agora, com o frete pago.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'auction.paid',
        expect.objectContaining({ orderId: 'order_1', shippingInCents: 1550 }),
      );
    });

    // ── Captura da retenção (o valor retido É o valor cobrado) ────────────
    /**
     * O lance já bloqueou no cartão exatamente o valor da peça. Cobrar de novo
     * do zero obrigava o comprador a ter o DOBRO do limite: quem desse um lance
     * de R$500 com R$500 de limite ganhava e não conseguia arrematar.
     *
     * Estes testes travam a regra: a peça vira pagamento por CAPTURA, e só o
     * frete — que a retenção não cobria — vira cobrança nova.
     */
    describe('captura da retenção', () => {
      /** order, endereço, leilão, lance(auth), + as leituras da consolidação. */
      const encenarCaptura = (over: Record<string, unknown> = {}) => {
        mockDb = makeDrizzleMock();
        mockDb.where
          .mockResolvedValueOnce([{ ...pendingOrder, ...over }])
          .mockResolvedValueOnce([mockEndereco])
          .mockResolvedValueOnce([{ id: 'auction_1' }]) // leilão do pedido
          .mockResolvedValueOnce([
            { chargeId: 'ch_auth', orderId: 'or_auth', amountInCents: 6000 },
          ]) // retenção do lance, no valor da peça
          .mockResolvedValueOnce([{ id: 'auction_1' }]) // _concluir: leilão
          .mockResolvedValueOnce([
            { chargeId: 'ch_auth', orderId: 'or_auth', amountInCents: 6000 },
          ]) // _concluir: auth
          .mockResolvedValueOnce([{ id: 'auction_1' }]); // _settle: leilão
      };

      /** Frete aprovado + captura aprovada. */
      const pagarmeFeliz = () =>
        mockPagarmeService.post
          .mockReset()
          .mockImplementation((rota: string) =>
            rota.endsWith('/capture')
              ? Promise.resolve({ id: 'ch_auth', status: 'paid' })
              : Promise.resolve({
                  id: 'or_frete',
                  status: 'paid',
                  charges: [{ id: 'ch_frete', status: 'paid' }],
                }),
          );

      it('CAPTURA a peça em vez de cobrá-la de novo', async () => {
        encenarCaptura({
          totalInCents: 6000,
          shippingInCents: 0,
          deliveryMethod: 'pickup',
          shippingServiceId: null,
        });
        pagarmeFeliz();
        service = await buildModule();

        await service.payAuctionOrder(bidderId, 'order_1');

        expect(mockPagarmeService.post).toHaveBeenCalledWith(
          '/charges/ch_auth/capture',
          { amount: 6000 },
          expect.any(String),
        );
        // Nenhuma cobrança nova: na retirada em mãos a captura resolve sozinha.
        const ordersCriadas = mockPagarmeService.post.mock.calls.filter(
          ([rota]: [string]) => rota === '/orders',
        );
        expect(ordersCriadas).toHaveLength(0);
      });

      it('cobra SÓ o frete à parte, e o frete vai sem split (é da Kolecta)', async () => {
        encenarCaptura();
        pagarmeFeliz();
        service = await buildModule();

        await service.payAuctionOrder(bidderId, 'order_1');

        const [rota, corpo] = mockPagarmeService.post.mock.calls.find(
          ([r]: [string]) => r === '/orders',
        );
        expect(rota).toBe('/orders');
        expect(corpo.items).toEqual([
          expect.objectContaining({ amount: 1550 }), // só o frete, não o total
        ]);
        expect(corpo.payments[0].credit_card.split).toBeUndefined();
        // E a peça segue vindo da retenção.
        expect(mockPagarmeService.post).toHaveBeenCalledWith(
          '/charges/ch_auth/capture',
          { amount: 6000 },
          expect.any(String),
        );
      });

      /**
       * A retenção VIROU o pagamento. Cancelá-la depois desfaria a venda — e o
       * `_concluirArrematePago` só cancela quando a auth é diferente do charge
       * consolidado, o que aqui não acontece.
       */
      it('NÃO cancela a retenção que acabou de virar pagamento', async () => {
        encenarCaptura();
        pagarmeFeliz();
        service = await buildModule();

        await service.payAuctionOrder(bidderId, 'order_1');

        expect(mockPagarmeService.delete).not.toHaveBeenCalledWith(
          '/charges/ch_auth',
        );
      });

      /**
       * A ordem é frete → captura porque a recusa provável é a do frete
       * (limite novo). Falhando primeiro o que tem mais chance de falhar, o
       * abandono é limpo: a retenção fica intacta e ele tenta de novo.
       */
      it('frete recusado NÃO captura a peça', async () => {
        encenarCaptura();
        mockPagarmeService.post.mockReset().mockResolvedValue({
          id: 'or_frete',
          status: 'failed',
          charges: [{ id: 'ch_frete', status: 'failed' }],
        });
        service = await buildModule();

        await expect(
          service.payAuctionOrder(bidderId, 'order_1'),
        ).rejects.toThrow(BadRequestException);

        expect(mockPagarmeService.post).not.toHaveBeenCalledWith(
          '/charges/ch_auth/capture',
          expect.anything(),
          expect.anything(),
        );
        expect(mockWalletService.hold).not.toHaveBeenCalled();
      });

      /** Frete pago e peça não: ele não recebe nada pelo frete. Devolve. */
      it('ESTORNA o frete se a captura da peça falhar depois', async () => {
        encenarCaptura();
        mockPagarmeService.post
          .mockReset()
          .mockImplementation((rota: string) =>
            rota.endsWith('/capture')
              ? Promise.reject(new Error('captura recusada'))
              : Promise.resolve({
                  id: 'or_frete',
                  status: 'paid',
                  charges: [{ id: 'ch_frete', status: 'paid' }],
                }),
          );
        service = await buildModule();

        await expect(
          service.payAuctionOrder(bidderId, 'order_1'),
        ).rejects.toThrow(BadRequestException);

        expect(mockPagarmeService.delete).toHaveBeenCalledWith(
          '/charges/ch_frete',
        );
        expect(mockWalletService.hold).not.toHaveBeenCalled();
      });

      /**
       * Capturar acima do autorizado não é permitido, e capturar a menos
       * deixaria a diferença sem pagamento. Valor que não bate → cobra do zero.
       */
      it('cai no fallback quando o autorizado não cobre a peça', async () => {
        mockDb = makeDrizzleMock();
        mockDb.where
          .mockResolvedValueOnce([pendingOrder])
          .mockResolvedValueOnce([mockEndereco])
          .mockResolvedValueOnce([{ id: 'auction_1' }])
          .mockResolvedValueOnce([
            { chargeId: 'ch_auth', orderId: 'or_auth', amountInCents: 5000 },
          ]) // autorizado MENOR que a peça (6000)
          .mockResolvedValueOnce([
            { recipientId: 're_seller', canReceive: true },
          ])
          .mockResolvedValueOnce([{ title: 'Hot Wheels' }])
          .mockResolvedValueOnce([{ id: 'auction_1' }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: 'auction_1' }]);
        mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
        service = await buildModule();

        await service.payAuctionOrder(bidderId, 'order_1');

        expect(mockPagarmeService.post).toHaveBeenCalledWith(
          '/orders',
          expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({ amount: 6000 }),
            ]),
          }),
          expect.any(String),
        );
        expect(mockPagarmeService.post).not.toHaveBeenCalledWith(
          '/charges/ch_auth/capture',
          expect.anything(),
          expect.anything(),
        );
      });

      /**
       * A dúvida (`null` da consulta) pesa para o lado da CAPTURA: cobrar do
       * zero com a retenção viva prenderia os dois valores — o problema que
       * esta mudança existe para acabar. Só a certeza de que sumiu desvia.
       */
      it('retenção comprovadamente SUMIDA cai no fallback', async () => {
        mockDb = makeDrizzleMock();
        mockDb.where
          .mockResolvedValueOnce([pendingOrder])
          .mockResolvedValueOnce([mockEndereco])
          .mockResolvedValueOnce([{ id: 'auction_1' }])
          .mockResolvedValueOnce([
            { chargeId: 'ch_auth', orderId: 'or_auth', amountInCents: 6000 },
          ])
          .mockResolvedValueOnce([
            { recipientId: 're_seller', canReceive: true },
          ])
          .mockResolvedValueOnce([{ title: 'Hot Wheels' }])
          .mockResolvedValueOnce([{ id: 'auction_1' }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: 'auction_1' }]);
        // A retenção não está mais lá.
        mockPagarmeService.get.mockResolvedValueOnce({
          status: 'canceled',
          last_transaction: { status: 'canceled' },
        });
        mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
        service = await buildModule();

        await service.payAuctionOrder(bidderId, 'order_1');

        expect(mockPagarmeService.post).toHaveBeenCalledWith(
          '/orders',
          expect.anything(),
          expect.any(String),
        );
      });
    });

    /**
     * O antifraude lê a descrição dos itens e o destino. Uma linha só
     * ("Arremate Kolecta #abc123"), sem endereço, chega como um valor solto —
     * indistinguível de teste de cartão. Foi o payload que teve um arremate
     * barrado em 12/08, enquanto o checkout, que discrimina, aprova.
     */
    it('declara o DESTINO da entrega — e sem `amount`, que a Pagar.me somaria', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([{ ...pendingOrder, addressId: 'addr_1' }])
        .mockResolvedValueOnce([mockEndereco]) // endereço de cobrança
        // Sem leilao localizado => sem retencao: cai no fallback de cobrar o total.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([{ title: 'Hot Wheels Sam Walton' }]) // anúncio
        .mockResolvedValueOnce([
          { ...mockEndereco, recipientName: 'Billy Gois' },
        ]) // endereço do pedido
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // auction (p/ ler a auth)
        .mockResolvedValueOnce([]) // sem pré-auth de pé
        .mockResolvedValueOnce([{ id: 'auction_1' }]);
      mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
      service = await buildModule();

      await service.payAuctionOrder(bidderId, 'order_1');

      const corpo = mockPagarmeService.post.mock.calls[0][1];
      expect(corpo.shipping).toEqual({
        description: 'Entrega Kolecta',
        recipient_name: 'Billy Gois',
        address: {
          line_1: '100, Rua Teste, Centro',
          zip_code: '01310100',
          city: 'Sao Paulo',
          state: 'SP',
          country: 'BR',
        },
      });
      // Com `amount` a Pagar.me SOMA o valor ao total (2553 virou 4106 na API)
      // e o comprador pagaria o frete duas vezes.
      expect(corpo.shipping).not.toHaveProperty('amount');
    });

    it('retirada em mãos não declara destino, e o item é só a peça', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([
          {
            ...pendingOrder,
            totalInCents: 6000,
            shippingInCents: 0,
            shippingServiceId: null,
            deliveryMethod: 'pickup',
          },
        ])
        .mockResolvedValueOnce([mockEndereco])
        // Sem leilao localizado => sem retencao: cai no fallback de cobrar o total.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([{ title: 'Mazda RX7 FD3S' }])
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // auction (p/ ler a auth)
        .mockResolvedValueOnce([]) // sem pré-auth de pé
        .mockResolvedValueOnce([{ id: 'auction_1' }]);
      mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
      service = await buildModule();

      await service.payAuctionOrder(bidderId, 'order_1');

      const corpo = mockPagarmeService.post.mock.calls[0][1];
      expect(corpo.shipping).toBeUndefined();
      expect(corpo.items).toEqual([
        {
          amount: 6000,
          description: 'Mazda RX7 FD3S',
          quantity: 1,
          code: mockListingId,
        },
      ]);
    });

    /**
     * Contexto melhor não vale uma cobrança recusada: a Pagar.me rejeita a
     * order inteira se a soma dos itens não bater com o cobrado (ou se um item
     * vier zerado). Nesse caso volta para a linha única, que é sempre correta.
     */
    it('cai para a linha única quando os itens não fecham com o total', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([
          // Frete igual ao total: a parte da peça daria zero.
          { ...pendingOrder, totalInCents: 1550, shippingInCents: 1550 },
        ])
        .mockResolvedValueOnce([mockEndereco])
        // Sem leilao localizado => sem retencao: cai no fallback de cobrar o total.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([{ title: 'Hot Wheels Sam Walton' }])
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // auction (p/ ler a auth)
        .mockResolvedValueOnce([]) // sem pré-auth de pé
        .mockResolvedValueOnce([{ id: 'auction_1' }]);
      mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
      service = await buildModule();

      await service.payAuctionOrder(bidderId, 'order_1');

      const corpo = mockPagarmeService.post.mock.calls[0][1];
      expect(corpo.items).toEqual([
        {
          amount: 1550,
          description: 'Arremate Kolecta #order_1',
          quantity: 1,
          code: 'kolecta-bid-payment',
        },
      ]);
    });

    /**
     * REGRESSÃO (12/08): a cobrança do arremate ia sem `billing_address` e a
     * Pagar.me recusava o request inteiro com `validation_error | billing |
     * "value" is required` — antes de qualquer análise de risco. O checkout
     * (026ec07) e o lance (c469505) receberam o endereço em 25/07; este
     * terceiro caminho ficou de fora porque nenhum leilão tinha fechado ainda.
     * O cartão salvo nasce só do token, então o endereço PRECISA ir no payload.
     */
    it('manda o billing_address do cadastro no cartão', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([pendingOrder])
        .mockResolvedValueOnce([mockEndereco]) // endereço de cobrança
        // Sem leilao localizado => sem retencao: cai no fallback de cobrar o total.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // auction (p/ ler a auth)
        .mockResolvedValueOnce([]) // sem pré-auth de pé
        .mockResolvedValueOnce([{ id: 'auction_1' }]);
      mockPagarmeService.post.mockReset().mockResolvedValue(paidOrder);
      service = await buildModule();

      await service.payAuctionOrder(bidderId, 'order_1');

      expect(mockPagarmeService.post).toHaveBeenCalledWith(
        '/orders',
        expect.objectContaining({
          payments: [
            expect.objectContaining({
              credit_card: expect.objectContaining({
                card_id: 'card_1',
                card: {
                  billing_address: {
                    // "número, rua, bairro" numa linha só, como a Pagar.me espera.
                    line_1: '100, Rua Teste, Centro',
                    zip_code: '01310100', // sem máscara
                    city: 'Sao Paulo',
                    state: 'SP',
                    country: 'BR',
                  },
                },
              }),
            }),
          ],
        }),
        expect.any(String),
      );
    });

    it('RECUSA pagar, sem chamar a Pagar.me, se o comprador não tem endereço', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([pendingOrder])
        .mockResolvedValueOnce([]); // nenhum endereço cadastrado
      service = await buildModule();

      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow(/endereço de cobrança/i);
      // Falhar aqui, dizendo o que fazer, é melhor que levar um
      // `validation_error` do gateway travestido de "cartão recusado".
      expect(mockPagarmeService.post).not.toHaveBeenCalled();
      expect(mockWalletService.hold).not.toHaveBeenCalled();
    });

    /**
     * O catch trocava QUALQUER falha por "tente outro cartão" — foi ele que
     * escondeu a ausência do endereço por dois dias, mandando o comprador
     * trocar de cartão por um erro que não era do cartão. Na validação, a
     * Pagar.me devolve `errors` como OBJETO indexado pelo campo, não como
     * lista: ler só a lista devolvia "Erro na comunicação com a Pagar.me".
     */
    it('entrega o motivo REAL da Pagar.me quando o request é invalidado', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([pendingOrder])
        .mockResolvedValueOnce([mockEndereco])
        // Sem leilao localizado => sem retencao: cai no fallback de cobrar o total.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
        .mockResolvedValueOnce([{ title: 'Hot Wheels Sam Walton' }]); // anúncio
      mockPagarmeService.post.mockReset().mockRejectedValue({
        response: {
          message: 'Erro na comunicação com a Pagar.me',
          pagarme: {
            message: 'The request is invalid.',
            errors: { billing: ['"value" is required'] },
          },
        },
      });
      service = await buildModule();

      await expect(
        service.payAuctionOrder(bidderId, 'order_1'),
      ).rejects.toThrow('billing: "value" is required');
      expect(mockWalletService.hold).not.toHaveBeenCalled();
    });
  });

  // ── handlePagarmeAuctionPaid (conciliação por webhook) ───────────────────

  /**
   * Arremate pago FORA do fluxo do site — reprocessamento no painel da
   * Pagar.me, por exemplo. Antes o `order.paid` do leilão caía no handler do
   * checkout, que só conhece o status `pending`; o de leilão é
   * `pending_payment`. O webhook saía calado e era gravado como `processed`.
   * Em 12/08 um arremate de R$ 200 pago pelo painel ficou invisível aqui, a
   * caminho de ser cancelado pelo cron com o dinheiro já capturado.
   */
  describe('handlePagarmeAuctionPaid', () => {
    const pendingOrder = {
      id: 'order_1',
      buyerId: bidderId,
      sellerId,
      listingId: mockListingId,
      totalInCents: 20000,
      shippingInCents: 0,
      deliveryMethod: 'pickup',
      sellerNetInCents: 17800,
      platformFeeInCents: 2200,
      status: 'pending_payment',
    };

    const evento = (over: Record<string, unknown> = {}) => ({
      id: 'or_reprocessado',
      metadata: { type: 'bid_payment', orderId: 'order_1' },
      charges: [{ id: 'ch_novo', status: 'paid' }],
      ...over,
    });

    it('consolida o pedido e LIBERA a retenção do lance', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([pendingOrder]) // pedido
        .mockResolvedValueOnce([{ id: 'auction_1' }]) // auction
        .mockResolvedValueOnce([{ chargeId: 'ch_bid', orderId: 'or_bid' }]) // pré-auth: LIDA ANTES do settle
        .mockResolvedValueOnce([{ id: 'auction_1' }]); // _settle
      service = await buildModule();

      await service.handlePagarmeAuctionPaid(evento());

      // Líquido do vendedor retido na wallet — o que não tinha acontecido.
      expect(mockWalletService.hold).toHaveBeenCalled();
      // A pré-auth do lance cai: sem isso o comprador fica com o valor
      // cobrado E o valor retido presos no cartão ao mesmo tempo.
      expect(mockPagarmeService.delete).toHaveBeenCalledWith('/charges/ch_bid');
      // Etiqueta/aviso seguem pelo mesmo evento do fluxo normal.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'auction.paid',
        expect.objectContaining({ orderId: 'order_1' }),
      );
    });

    /**
     * REGRESSÃO (12/08): a retenção do lance NUNCA era liberada.
     *
     * `_settlePaidAuctionOrder` marca o lance vencedor como `won` dentro da
     * transação, e `_getActiveBidAuth` filtra por `status = 'active'`. Lendo a
     * auth DEPOIS de consolidar, a busca não achava mais nada e o void não
     * acontecia: o vencedor ficava com o valor cobrado E o valor retido presos
     * ao mesmo tempo, até a adquirente expirar sozinha (~5 dias). Dois
     * arremates de 11/08 ficaram assim, R$ 460 travados à toa.
     *
     * Este teste trava a ORDEM, não só o efeito — foi a ordem que quebrou, e o
     * efeito passava mesmo errado porque o mock devolve a auth de qualquer
     * jeito.
     */
    it('lê a pré-auth ANTES de consolidar (senão o lance já virou `won`)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([pendingOrder])
        .mockResolvedValueOnce([{ id: 'auction_1' }])
        .mockResolvedValueOnce([{ chargeId: 'ch_bid', orderId: 'or_bid' }])
        .mockResolvedValueOnce([{ id: 'auction_1' }]);
      service = await buildModule();

      await service.handlePagarmeAuctionPaid(evento());

      // 3ª leitura = a auth do lance; a transação é onde o lance vira `won`.
      const leituraDaAuth = mockDb.where.mock.invocationCallOrder[2];
      const consolidacao = mockDb.transaction.mock.invocationCallOrder[0];
      expect(leituraDaAuth).toBeLessThan(consolidacao);
      expect(mockPagarmeService.delete).toHaveBeenCalledWith('/charges/ch_bid');
    });

    /**
     * No caminho normal o site liquida dentro da própria requisição e o
     * webhook chega logo atrás. Sair calado é o esperado — não pode reter o
     * líquido do vendedor duas vezes.
     */
    it('NÃO faz nada quando o pedido já foi liquidado pelo site', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([{ ...pendingOrder, status: 'paid' }]);
      service = await buildModule();

      await service.handlePagarmeAuctionPaid(evento());

      expect(mockWalletService.hold).not.toHaveBeenCalled();
      expect(mockPagarmeService.delete).not.toHaveBeenCalled();
    });

    it('ignora evento sem orderId no metadata', async () => {
      mockDb = makeDrizzleMock();
      service = await buildModule();

      await service.handlePagarmeAuctionPaid(evento({ metadata: {} }));

      expect(mockWalletService.hold).not.toHaveBeenCalled();
    });

    it('não quebra quando o pedido não existe mais', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]);
      service = await buildModule();

      await expect(
        service.handlePagarmeAuctionPaid(evento()),
      ).resolves.toBeUndefined();
      expect(mockWalletService.hold).not.toHaveBeenCalled();
    });
  });

  // ── expireOverduePendingPayments (Fase 4) ────────────────────────────────

  describe('expireOverduePendingPayments', () => {
    const overdueOrder = {
      id: 'order_ov',
      buyerId: bidderId,
      sellerId,
      listingId: mockListingId,
      totalInCents: 6000,
      status: 'pending_payment',
      paymentDeadlineAt: new Date(Date.now() - 1000),
    };

    // Override de update().set().where() para separar dos selects (que usam
    // mockDb.where): o cancel usa .returning(); os demais updates são awaited.
    const stubUpdatesWithCancel = (cancelResult: any[]) => {
      mockDb.set = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(cancelResult),
        }),
      });
    };

    it('retorna vazio quando não há pedidos vencidos', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([]); // nenhum vencido
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result).toEqual({ expired: [], offered: [], reopened: [] });
    });

    /**
     * O PORTÃO: ninguém é cancelado sem perguntar à Pagar.me.
     *
     * Cancelar um pedido já pago é o pior desfecho possível — o item vai ao 2º
     * colocado com o dinheiro do 1º capturado. Faltou pouco em 12/08: um
     * arremate pago pelo painel ficou `pending_payment` porque o webhook falhou,
     * e este cron o cancelaria no dia seguinte.
     */
    it('NÃO cancela quando a Pagar.me diz que o pedido está PAGO', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([overdueOrder]);
      mockConciliacaoService.conciliarPedido
        .mockReset()
        .mockResolvedValue({ acao: 'liquidado' });
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result.expired).toEqual([]);
      expect(mockConciliacaoService.conciliarPedido).toHaveBeenCalledWith(
        'order_ov',
      );
      mockConciliacaoService.conciliarPedido
        .mockReset()
        .mockResolvedValue({ acao: 'nao-pago' });
    });

    /**
     * Não saber não autoriza destruir uma venda: se a consulta falhar, o
     * cancelamento espera a próxima rodada.
     */
    it('NÃO cancela quando não deu para conferir na Pagar.me', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([overdueOrder]);
      mockConciliacaoService.conciliarPedido
        .mockReset()
        .mockResolvedValue({ acao: 'erro-consulta', detalhe: 'timeout' });
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result.expired).toEqual([]);
      mockConciliacaoService.conciliarPedido
        .mockReset()
        .mockResolvedValue({ acao: 'nao-pago' });
    });

    it('REABRE o anúncio quando não há 2º colocado apto', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([overdueOrder]) // vencidos
        .mockResolvedValueOnce([{ id: 'auction_1', reservePriceInCents: null }]) // auction por listingId
        .mockResolvedValueOnce([]); // _getActiveBidAuth: sem pré-auth de pé
      stubUpdatesWithCancel([overdueOrder]); // cancelou o pedido
      // _findRunnerUp: só há lances do próprio vencedor faltoso → sem elegível.
      mockDb.orderBy.mockResolvedValue([
        { bidId: 'b1', bidderId, amountInCents: 6000, status: 'lost' },
      ]);
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result.expired).toContain('order_ov');
      expect(result.reopened).toContain('order_ov');
      expect(result.offered).toEqual([]);
    });

    /**
     * Virou obrigatório quando o fecho parou de capturar: todo arremate nasce
     * com uma pré-auth VIVA segurando o cartão. Quem desiste não pode ficar com
     * o limite preso até a adquirente expirar sozinha (~5 dias).
     */
    it('LIBERA a retenção do cartão do faltoso ao expirar o prazo', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([overdueOrder])
        .mockResolvedValueOnce([{ id: 'auction_1', reservePriceInCents: null }])
        .mockResolvedValueOnce([
          { chargeId: 'ch_faltoso', orderId: 'or_faltoso' },
        ]); // pré-auth de pé
      stubUpdatesWithCancel([overdueOrder]);
      mockDb.orderBy.mockResolvedValue([
        { bidId: 'b1', bidderId, amountInCents: 6000, status: 'lost' },
      ]);
      service = await buildModule();

      await service.expireOverduePendingPayments();

      expect(mockPagarmeService.delete).toHaveBeenCalledWith(
        '/charges/ch_faltoso',
      );
    });

    it('OFERECE ao 2º colocado quando existe lance elegível acima da reserva', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where
        .mockResolvedValueOnce([overdueOrder]) // vencidos
        .mockResolvedValueOnce([{ id: 'auction_1', reservePriceInCents: 3000 }]) // auction
        .mockResolvedValueOnce([]) // _getActiveBidAuth: sem pré-auth de pé
        // _findRunnerUp segue a cadeia até orderBy — precisa do chain, não de
        // um array; só depois dele vêm o endereço e o título do anúncio.
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: 'end_2', isDefault: true }]) // endereço do 2º
        .mockResolvedValueOnce([{ title: 'Item de teste' }]); // título p/ o e-mail
      stubUpdatesWithCancel([overdueOrder]);
      // Vencedor faltoso (buyer_001) + 2º colocado (buyer_002) com lance válido.
      mockDb.orderBy.mockResolvedValue([
        { bidId: 'b1', bidderId, amountInCents: 6000, status: 'lost' },
        {
          bidId: 'b2',
          bidderId: 'buyer_002',
          amountInCents: 5000,
          status: 'outbid',
        },
      ]);
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result.expired).toContain('order_ov');
      expect(result.offered).toContain('order_ov');
      expect(result.reopened).toEqual([]);
      // O promovido tem prazo correndo e precisa escolher o frete — antes era
      // promovido no silêncio, o que garantia que o prazo vencesse de novo.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'auction.won',
        expect.objectContaining({
          winnerId: 'buyer_002',
          needsShippingChoice: true,
        }),
      );
    });

    it('não conta como expirado se o cancelamento perde a corrida (já pago)', async () => {
      mockDb = makeDrizzleMock();
      mockDb.where.mockResolvedValueOnce([overdueOrder]); // vencidos
      stubUpdatesWithCancel([]); // cancel não afetou linhas → noop
      service = await buildModule();

      const result = await service.expireOverduePendingPayments();

      expect(result.expired).toEqual([]);
    });
  });
});

/**
 * Reenvio do aviso de arremate.
 *
 * O aviso sai UMA vez, no fecho, e não havia como repeti-lo. Quando ele se
 * perde, o vencedor nunca fica sabendo — e o prazo corre igual: vencido, a
 * pré-auth é liberada e a peça vai para o 2º colocado. Em 11/08/2026 dois
 * arremates (R$ 460) ficaram nessa situação porque o cadastro do comprador
 * tinha e-mail placeholder, e não existia socorro nenhum.
 */
describe('AuctionsService — reenviar aviso de arremate', () => {
  const PEDIDO = {
    id: 'ord-1',
    buyerId: 'user_bidder',
    listingId: 'lst-1',
    status: 'pending_payment',
    totalInCents: 26000,
    shippingInCents: 0,
    shippingServiceId: null,
    deliveryMethod: 'shipping',
    paymentDeadlineAt: new Date(Date.now() + 45 * 3_600_000),
  };

  function montar(over: any = {}) {
    const emitter = { emit: jest.fn() };
    const db: any = {
      query: {
        orders: {
          findFirst: jest.fn().mockResolvedValue(over.order ?? PEDIDO),
        },
        auctions: {
          findFirst: jest
            .fn()
            .mockResolvedValue(
              'auction' in over ? over.auction : { id: 'auc-1' },
            ),
        },
        listings: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ title: 'Hot Wheels Sam Walton' }),
        },
        users: {
          findFirst: jest
            .fn()
            .mockResolvedValue(
              'user' in over
                ? over.user
                : { id: 'user_bidder', email: 'billy@real.com.br' },
            ),
        },
      },
    };
    const service = new AuctionsService(
      db,
      mockWalletService as any,
      mockFounderService as any,
      mockCardsService as any,
      mockPagarmeService as any,
      mockShippingService as any,
      mockFreteSubsidioService as any,
      mockConciliacaoService as any,
      emitter as any,
    );
    return { service, emitter };
  }

  it('reemite auction.won com o prazo que REALMENTE sobra', async () => {
    const { service, emitter } = montar();

    const r = await service.reenviarAvisoDeArremate('ord-1');

    expect(emitter.emit).toHaveBeenCalledWith(
      'auction.won',
      expect.objectContaining({
        orderId: 'ord-1',
        winnerId: 'user_bidder',
        needsPayment: true,
        needsShippingChoice: true,
        finalAmountInCents: 26000,
      }),
    );
    // 45h restantes, não as 48h originais: o e-mail chega depois, e repetir o
    // prazo cheio faria o vencedor se planejar pelo número errado.
    const payload = emitter.emit.mock.calls[0][1] as any;
    expect(payload.paymentDeadlineHours).toBe(44);
    expect(r.destinatario).toBe('billy@real.com.br');
  });

  it('não pede escolha de frete a quem já escolheu', async () => {
    const { service, emitter } = montar({
      order: {
        ...PEDIDO,
        shippingServiceId: 1,
        shippingInCents: 2274,
        totalInCents: 28274,
      },
    });

    await service.reenviarAvisoDeArremate('ord-1');

    const payload = emitter.emit.mock.calls[0][1] as any;
    expect(payload.needsShippingChoice).toBe(false);
    // O valor anunciado é o da PEÇA: somar o frete mostraria um total que o
    // vencedor não reconheceria do leilão.
    expect(payload.finalAmountInCents).toBe(26000);
  });

  /**
   * Reenviar para um cadastro quebrado repetiria o problema original em
   * silêncio. Melhor recusar e mandar consertar o cadastro primeiro.
   */
  it('recusa quando o vencedor não tem e-mail', async () => {
    const { service, emitter } = montar({
      user: { id: 'user_bidder', email: null },
    });

    await expect(service.reenviarAvisoDeArremate('ord-1')).rejects.toThrow(
      /e-mail/i,
    );
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('recusa pedido que não está aguardando pagamento', async () => {
    const { service, emitter } = montar({
      order: { ...PEDIDO, status: 'paid' },
    });

    await expect(service.reenviarAvisoDeArremate('ord-1')).rejects.toThrow(
      /pending_payment/,
    );
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('recusa pedido que não veio de leilão', async () => {
    const { service, emitter } = montar({ auction: null });

    await expect(service.reenviarAvisoDeArremate('ord-1')).rejects.toThrow(
      /não veio de leilão/i,
    );
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
