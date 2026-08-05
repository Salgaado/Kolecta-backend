import { Test, TestingModule } from '@nestjs/testing';
import { MessagesService } from './messages.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Emissor de eventos: só precisamos observar o que foi emitido.
const mockEventEmitter = { emit: jest.fn() };
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';

const fakeConversation = {
  id: 'conv_123',
  listingId: 'listing_123',
  buyerId: 'buyer_123',
  sellerId: 'seller_123',
  createdAt: new Date(),
  updatedAt: new Date(),
  listing: {
    id: 'listing_123',
    title: 'Anuncio Teste',
    sellerId: 'seller_123',
  },
};

const fakeMessage = {
  id: 'msg_123',
  conversationId: 'conv_123',
  senderId: 'buyer_123',
  content: 'Olá',
  readAt: null,
  createdAt: new Date(),
};

const queryMock = {
  conversations: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  messages: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  listings: {
    findFirst: jest.fn(),
  },
  // Gating de chat (29/05): exige transação confirmada
  orders: {
    findFirst: jest.fn(),
  },
};

const insertChain = {
  values: jest.fn().mockReturnThis(),
  returning: jest.fn(),
};

const updateChain = {
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockResolvedValue(undefined),
};

// getConversations usa this.db.select().from().leftJoin()...; cada select é uma
// cadeia thenable que resolve para o resultado enfileirado.
function selectChain(result: unknown) {
  const chain: any = {
    from: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return chain;
}

const mockDb = {
  query: queryMock,
  select: jest.fn(),
  insert: () => insertChain,
  update: () => updateChain,
};

describe('MessagesService', () => {
  let service: MessagesService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: DATABASE_CONNECTION, useValue: mockDb },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<MessagesService>(MessagesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getConversations', () => {
    it('deve retornar as conversas do usuário', async () => {
      // 1º select = query principal (com joins); 2º = não lidas; 3º = última msg
      mockDb.select
        .mockReturnValueOnce(
          selectChain([
            {
              conversation: fakeConversation,
              listing: fakeConversation.listing,
              buyer: { id: 'buyer_123' },
              seller: { id: 'seller_123' },
            },
          ]),
        )
        .mockReturnValueOnce(selectChain([])) // unread
        .mockReturnValueOnce(selectChain([fakeMessage])); // latest

      const result = await service.getConversations('buyer_123');

      expect(result).toHaveLength(1);
      expect(result[0].unreadCount).toBe(0);
      expect(result[0].latestMessage).toEqual(fakeMessage);
    });
  });

  describe('startConversation', () => {
    it('deve criar uma nova conversa e mensagem inicial se não existir', async () => {
      queryMock.listings.findFirst.mockResolvedValueOnce({
        id: 'listing_123',
        sellerId: 'seller_123',
      });
      // Gating: transação confirmada entre comprador e vendedor
      queryMock.orders.findFirst.mockResolvedValueOnce({
        id: 'order_1',
        status: 'paid',
      });
      queryMock.conversations.findFirst.mockResolvedValueOnce(null);

      insertChain.returning
        .mockResolvedValueOnce([{ id: 'new_conv_123' }]) // conv
        .mockResolvedValueOnce([{ id: 'new_msg_123', content: 'Oi' }]); // msg

      const result = await service.startConversation('buyer_123', {
        listingId: 'listing_123',
        message: 'Oi',
      });

      expect(result.conversationId).toBe('new_conv_123');
      expect(result.message?.id).toBe('new_msg_123');
    });

    it('deve lançar Forbidden sem transação confirmada', async () => {
      queryMock.listings.findFirst.mockResolvedValueOnce({
        id: 'listing_123',
        sellerId: 'seller_123',
      });
      queryMock.orders.findFirst.mockResolvedValueOnce(undefined); // sem pedido

      await expect(
        service.startConversation('buyer_123', {
          listingId: 'listing_123',
          message: 'Oi',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deve lançar erro se tentar criar conversa no próprio anuncio', async () => {
      queryMock.listings.findFirst.mockResolvedValueOnce({
        id: 'listing_123',
        sellerId: 'seller_123',
      });

      await expect(
        service.startConversation('seller_123', {
          listingId: 'listing_123',
          message: 'Oi',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('sendMessage', () => {
    it('deve inserir a mensagem na conversa existente', async () => {
      queryMock.conversations.findFirst.mockResolvedValueOnce(fakeConversation);
      insertChain.returning.mockResolvedValueOnce([
        { id: 'new_msg_123', content: 'Nova' },
      ]);

      const result = await service.sendMessage('buyer_123', 'conv_123', {
        content: 'Nova',
      });

      expect(result.id).toBe('new_msg_123');
      expect(updateChain.set).toHaveBeenCalled(); // update conversation updatedAt
    });

    it('deve lançar Forbidden se o usuario nao for buyer ou seller', async () => {
      queryMock.conversations.findFirst.mockResolvedValueOnce(fakeConversation);

      await expect(
        service.sendMessage('hacker_999', 'conv_123', { content: 'Hack' }),
      ).rejects.toThrow(ForbiddenException);
    });

    // ── Destinatário do e-mail é sempre a CONTRAPARTE ──
    // Quem escreve não pode receber aviso do próprio recado.

    it('comprador escrevendo → e-mail vai para o vendedor', async () => {
      queryMock.conversations.findFirst.mockResolvedValueOnce(fakeConversation);
      insertChain.returning.mockResolvedValueOnce([{ id: 'm1' }]);

      await service.sendMessage('buyer_123', 'conv_123', { content: 'Oi' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'message.received',
        expect.objectContaining({
          senderId: 'buyer_123',
          recipientId: 'seller_123',
        }),
      );
    });

    it('vendedor escrevendo → e-mail vai para o comprador', async () => {
      queryMock.conversations.findFirst.mockResolvedValueOnce(fakeConversation);
      insertChain.returning.mockResolvedValueOnce([{ id: 'm2' }]);

      await service.sendMessage('seller_123', 'conv_123', { content: 'Olá' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'message.received',
        expect.objectContaining({
          senderId: 'seller_123',
          recipientId: 'buyer_123',
        }),
      );
    });

    // ── Qual caixa de entrada o e-mail deve indicar ──
    // Comprador lê em /conta/mensagens, vendedor em /painel/mensagens. É este
    // campo que o template usa para escolher; errar aqui manda o destinatário
    // para a caixa do outro, que foi o que aconteceu com os dois avisos reais.

    it('comprador escrevendo → destinatário é VENDEDOR (caixa do painel)', async () => {
      queryMock.conversations.findFirst.mockResolvedValueOnce(fakeConversation);
      insertChain.returning.mockResolvedValueOnce([{ id: 'm3' }]);

      await service.sendMessage('buyer_123', 'conv_123', { content: 'Oi' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'message.received',
        expect.objectContaining({ recipientIsSeller: true }),
      );
    });

    it('vendedor escrevendo → destinatário é COMPRADOR (caixa da conta)', async () => {
      queryMock.conversations.findFirst.mockResolvedValueOnce(fakeConversation);
      insertChain.returning.mockResolvedValueOnce([{ id: 'm4' }]);

      await service.sendMessage('seller_123', 'conv_123', { content: 'Olá' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'message.received',
        expect.objectContaining({ recipientIsSeller: false }),
      );
    });
  });
});
