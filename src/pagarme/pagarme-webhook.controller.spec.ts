import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PagarmeWebhookController } from './pagarme-webhook.controller';
import { PagarmeConfigService } from './pagarme-config.service';
import { WalletService } from '../wallet/wallet.service';
import { DATABASE_CONNECTION } from '../database/database.module';

/**
 * O roteamento do `order.paid` por `metadata.type`.
 *
 * Um `order.paid` de ARREMATE caía no handler do checkout, que só conhece o
 * status `pending` — pedido de leilão fica `pending_payment`. Nomes parecidos,
 * estados diferentes: o webhook lia, achava que já estava resolvido, saía
 * calado, e ainda era gravado como `processed`. Em 12/08 um arremate de R$ 200
 * pago pelo painel da Pagar.me ficou invisível no sistema, a caminho de ser
 * cancelado pelo cron de prazo com o dinheiro já capturado.
 */
const USER = 'kolecta';
const PASS = 'segredo';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const mockWallet = {
  getOrCreateWallet: jest.fn().mockResolvedValue({ id: 'w1' }),
  credit: jest.fn().mockResolvedValue(undefined),
};

const makeDb = () => {
  const chain: any = {};
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockResolvedValue(undefined);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.set = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue(undefined);
  // Sem evento anterior: o caminho de idempotência não é o foco aqui.
  chain.query = {
    webhookEvents: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  return chain;
};

describe('PagarmeWebhookController — roteamento do order.paid', () => {
  let controller: PagarmeWebhookController;
  let emitter: { emit: jest.Mock };
  let db: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = makeDb();
    emitter = { emit: jest.fn() };

    const mod: TestingModule = await Test.createTestingModule({
      controllers: [PagarmeWebhookController],
      providers: [
        { provide: WalletService, useValue: mockWallet },
        { provide: EventEmitter2, useValue: emitter },
        {
          provide: PagarmeConfigService,
          useValue: { webhookUser: USER, webhookPassword: PASS },
        },
        { provide: DATABASE_CONNECTION, useValue: db },
      ],
    }).compile();

    controller = mod.get(PagarmeWebhookController);
  });

  const evento = (metadata: Record<string, unknown>) => ({
    id: 'hook_1',
    type: 'order.paid',
    data: {
      id: 'or_1',
      metadata,
      charges: [{ id: 'ch_1', status: 'paid' }],
    },
  });

  it('arremate de leilão vai para o caminho do LEILÃO', async () => {
    await controller.handleWebhook(
      evento({ type: 'bid_payment', orderId: 'order_1' }) as any,
      AUTH,
    );

    expect(emitter.emit).toHaveBeenCalledWith(
      'pagarme.auction.paid',
      expect.objectContaining({ id: 'or_1' }),
    );
    // E NÃO para o do checkout, que ignoraria por causa do status.
    expect(emitter.emit).not.toHaveBeenCalledWith(
      'pagarme.order.paid',
      expect.anything(),
    );
  });

  it('compra direta continua indo para o caminho do checkout', async () => {
    await controller.handleWebhook(
      evento({ type: 'purchase', orderId: 'order_2' }) as any,
      AUTH,
    );

    expect(emitter.emit).toHaveBeenCalledWith(
      'pagarme.order.paid',
      expect.objectContaining({ id: 'or_1' }),
    );
    expect(emitter.emit).not.toHaveBeenCalledWith(
      'pagarme.auction.paid',
      expect.anything(),
    );
  });

  it('depósito de wallet não emite evento: credita direto', async () => {
    await controller.handleWebhook(
      {
        id: 'hook_2',
        type: 'order.paid',
        data: {
          id: 'or_3',
          amount: 5000,
          metadata: { type: 'wallet_deposit', userId: 'u1' },
        },
      } as any,
      AUTH,
    );

    expect(mockWallet.credit).toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('recusa quem não passa o Basic Auth', async () => {
    await expect(
      controller.handleWebhook(
        evento({ type: 'bid_payment' }) as any,
        'Basic errado',
      ),
    ).rejects.toThrow();
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
