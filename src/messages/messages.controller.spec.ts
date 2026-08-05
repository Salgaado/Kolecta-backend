import { Test, TestingModule } from '@nestjs/testing';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';

/**
 * O que este arquivo protege: o ENVELOPE da resposta, não a regra de negócio.
 *
 * O chat ficou com a caixa de entrada vazia para todo mundo — comprador e
 * vendedor — porque `GET /conversations` devolvia o array cru enquanto os
 * outros quatro endpoints devolviam `{ data }`. O front faz `.then(r => r.data)`
 * em cima de um array, recebe `undefined`, e o React Query v5 trata `undefined`
 * como erro de query: a lista caía no default `[]` e a tela dizia "nenhuma
 * conversa" com as conversas existindo no banco.
 *
 * Nada quebrava alto: sem erro 500, sem log, sem exceção no servidor. Por isso
 * o teste é do formato, e não do conteúdo — o conteúdo sempre esteve certo.
 *
 * A regra que estes testes fixam: **todo endpoint do chat responde `{ data }`,
 * exceto `markAsRead`, que responde `{ success }`.** Quem mudar isso de um lado
 * só quebra aqui, e não na caixa de entrada do usuário.
 */

const conversaFake = {
  id: 'conv_1',
  listingId: 'listing_1',
  buyerId: 'buyer_1',
  sellerId: 'seller_1',
  unreadCount: 2,
  latestMessage: { id: 'msg_1', content: 'Olá' },
};

const mensagemFake = {
  id: 'msg_1',
  conversationId: 'conv_1',
  senderId: 'buyer_1',
  content: 'Olá',
};

/** Reproduz o que `api.ts` faz com a resposta: `.then(r => r.data)`. */
function comoOFrontLe<T>(resposta: any): T {
  return resposta?.data;
}

describe('MessagesController (envelope da resposta)', () => {
  let controller: MessagesController;

  const service = {
    getConversations: jest.fn(),
    getConversation: jest.fn(),
    startConversation: jest.fn(),
    startFromOrder: jest.fn(),
    sendMessage: jest.fn(),
    markAsRead: jest.fn(),
  };

  const req = { auth: { userId: 'buyer_1' } } as any;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagesController],
      providers: [{ provide: MessagesService, useValue: service }],
    })
      // Os guards têm dependências próprias (Clerk, banco) e não são o assunto
      // aqui: o que está em teste é o formato do que sai do controller.
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<MessagesController>(MessagesController);
  });

  describe('GET /conversations — a regressão que esvaziou a caixa de entrada', () => {
    it('envelopa a lista em { data }, e não devolve o array cru', async () => {
      service.getConversations.mockResolvedValue([conversaFake]);

      const resposta: any = await controller.getConversations(req);

      // O array cru passaria em `toEqual([conversaFake])`. É exatamente esse
      // formato que quebrava o front, então o teste exige o envelope.
      expect(Array.isArray(resposta)).toBe(false);
      expect(resposta).toEqual({ data: [conversaFake] });
    });

    it('sobrevive ao .then(r => r.data) do front', async () => {
      service.getConversations.mockResolvedValue([conversaFake]);

      const lista = comoOFrontLe<any[]>(await controller.getConversations(req));

      // Este era o sintoma: `undefined` chegando no React Query.
      expect(lista).toBeDefined();
      expect(lista).toHaveLength(1);
      expect(lista[0].unreadCount).toBe(2);
    });

    it('lista vazia chega como [], e não como undefined', async () => {
      service.getConversations.mockResolvedValue([]);

      const lista = comoOFrontLe<any[]>(await controller.getConversations(req));

      // Diferença que importa: `[]` é "não tem conversa"; `undefined` é o
      // React Query v5 derrubando a query. Na tela os dois pareciam iguais.
      expect(lista).toEqual([]);
      expect(lista).not.toBeUndefined();
    });
  });

  describe('os demais endpoints já estavam certos — travando para não regredirem', () => {
    it('GET /conversations/:id devolve { data }', async () => {
      const payload = { conversation: conversaFake, messages: [mensagemFake] };
      service.getConversation.mockResolvedValue(payload);

      const lido = comoOFrontLe<any>(
        await controller.getConversation('conv_1', req),
      );

      expect(lido).toEqual(payload);
      expect(lido.messages).toHaveLength(1);
    });

    it('POST /conversations devolve { data }', async () => {
      service.startConversation.mockResolvedValue({
        conversationId: 'conv_1',
        message: mensagemFake,
      });

      const lido = comoOFrontLe<any>(
        await controller.startConversation(
          { listingId: 'listing_1', message: 'Olá' },
          req,
        ),
      );

      expect(lido.conversationId).toBe('conv_1');
    });

    it('POST /from-order/:orderId devolve { data }', async () => {
      service.startFromOrder.mockResolvedValue({ conversationId: 'conv_1' });

      const lido = comoOFrontLe<any>(
        await controller.startFromOrder('order_1', req),
      );

      expect(lido.conversationId).toBe('conv_1');
    });

    it('POST /conversations/:id devolve { data } com a mensagem gravada', async () => {
      service.sendMessage.mockResolvedValue(mensagemFake);

      const lido = comoOFrontLe<any>(
        await controller.sendMessage('conv_1', { content: 'Olá' }, req),
      );

      expect(lido).toEqual(mensagemFake);
    });

    it('PATCH /conversations/:id/read devolve { success } CRU, sem envelope', async () => {
      service.markAsRead.mockResolvedValue({ success: true });

      const resposta: any = await controller.markAsRead('conv_1', req);

      // Exceção consciente: o front lê `{ success }` direto, sem `.data`.
      // Envelopar aqui quebraria o marcar-como-lido.
      expect(resposta).toEqual({ success: true });
      expect(resposta.data).toBeUndefined();
    });
  });

  describe('a identidade vem do token, nunca do corpo ou da URL', () => {
    it('usa req.auth.userId ao listar', async () => {
      service.getConversations.mockResolvedValue([]);

      await controller.getConversations({ auth: { userId: 'outro_user' } } as any);

      expect(service.getConversations).toHaveBeenCalledWith('outro_user');
    });

    it('usa req.auth.userId ao enviar, e não deixa forjar remetente', async () => {
      service.sendMessage.mockResolvedValue(mensagemFake);

      await controller.sendMessage(
        'conv_1',
        { content: 'Olá', senderId: 'vitima' } as any,
        req,
      );

      // O remetente é sempre o dono do token; `senderId` no corpo é ignorado.
      expect(service.sendMessage).toHaveBeenCalledWith('buyer_1', 'conv_1', {
        content: 'Olá',
        senderId: 'vitima',
      });
    });
  });
});
