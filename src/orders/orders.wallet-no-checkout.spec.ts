/**
 * Pagar com saldo da carteira foi removido do checkout (31/07/2026).
 *
 * Motivo do provedor: a Pagar.me não transfere entre usuários — o saldo só sai
 * por saque. Motivo nosso, mais grave: a parte paga com saldo **não passava
 * pelo split**. A cobrança caía inteira na conta da Kolecta e o dinheiro do
 * vendedor existia só no nosso ledger, que é exatamente o que a Fase 1
 * (`orders.split-fail-closed.spec.ts`) fechou — só que por uma porta lateral,
 * aberta a pedido do cliente.
 *
 * O campo `useWalletBalance` continua aceito no DTO para não quebrar frontend
 * em cache. Estes testes provam que aceitar não é obedecer.
 */
process.env.PAGARME_PLATFORM_RECIPIENT_ID = 're_plataforma';

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DATABASE_CONNECTION } from '../database/database.module';
import { WalletService } from '../wallet/wallet.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { FounderService } from '../founder/founder.service';

const { OrdersService } = require('./orders.service');

const listing = {
  id: 'listing_001',
  sellerId: 'user_seller',
  title: 'Hot Wheels',
  status: 'active',
  priceInCents: 10000,
};

const endereco = {
  id: 'addr_1',
  userId: 'user_buyer',
  street: 'Rua Teste',
  number: '100',
  complement: null,
  neighborhood: 'Centro',
  city: 'Sao Paulo',
  state: 'SP',
  zip: '01310-100',
  country: 'BR',
};

describe('OrdersService — pagar com saldo não existe mais', () => {
  let service: any;
  let selectChain: any;
  let pagarme: any;
  let insertChain: any;
  let wallet: any;

  beforeEach(async () => {
    selectChain = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn(),
    };
    insertChain = {
      values: jest.fn().mockReturnThis(),
      returning: jest
        .fn()
        .mockResolvedValue([{ id: 'order_123', status: 'pending' }]),
    };
    const updateChain: any = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'order_123' }]),
      then: (resolve: any) => resolve(undefined),
    };
    const db = {
      select: () => selectChain,
      update: () => updateChain,
      insert: () => insertChain,
      transaction: jest.fn(async (cb: any) =>
        cb({ update: () => updateChain, insert: () => insertChain }),
      ),
    };

    pagarme = {
      post: jest.fn().mockResolvedValue({
        id: 'or_x',
        charges: [
          {
            id: 'ch_x',
            last_transaction: { qr_code: 'qr', qr_code_url: 'http://qr' },
          },
        ],
      }),
      get: jest.fn(),
    };

    // Comprador com saldo de sobra: R$ 500 para uma compra de R$ 115,50.
    wallet = {
      hold: jest.fn(),
      debit: jest.fn(),
      getOrCreateWallet: jest
        .fn()
        .mockResolvedValue({ id: 'w1', balanceInCents: 50000 }),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: DATABASE_CONNECTION, useValue: db },
        { provide: WalletService, useValue: wallet },
        { provide: PagarmeService, useValue: pagarme },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: FounderService,
          useValue: {
            resolveCommissionPercent: jest.fn().mockResolvedValue(11),
          },
        },
      ],
    }).compile();

    service = mod.get(OrdersService);
  });

  const semearCheckout = () => {
    selectChain.where
      .mockResolvedValueOnce([listing])
      .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
      .mockResolvedValueOnce([endereco])
      .mockResolvedValueOnce([
        { name: 'Comprador', email: 'b@x.com', cpf: null },
      ]);
  };

  /** Checkout de R$ 100 + R$ 15,50 de frete, pedindo abatimento no saldo. */
  const checkoutPedindoSaldo = () =>
    service.createCheckout('user_buyer', {
      items: [{ listingId: 'listing_001' }],
      buyerCpf: '529.982.247-25',
      buyerPhone: '11987654321',
      addressId: 'addr_1',
      shippingInCents: 1550,
      deliveryMethod: 'shipping',
      useWalletBalance: true,
    });

  it('cobra o valor CHEIO mesmo com saldo suficiente na carteira', async () => {
    semearCheckout();
    await checkoutPedindoSaldo();

    const [, body] = pagarme.post.mock.calls[0];
    // Item + frete entram como linhas separadas; o que importa é a soma.
    const cobrado = body.items.reduce(
      (t: number, i: any) => t + i.amount * (i.quantity ?? 1),
      0,
    );
    // R$ 115,50 — nada abatido, apesar dos R$ 500 disponíveis.
    expect(cobrado).toBe(11550);
  });

  it('não debita a carteira do comprador', async () => {
    semearCheckout();
    await checkoutPedindoSaldo();

    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('grava o pedido com zero de saldo aplicado', async () => {
    semearCheckout();
    await checkoutPedindoSaldo();

    const pedido = insertChain.values.mock.calls[0][0];
    expect(pedido.walletAmountInCents).toBe(0);
    expect(pedido.totalInCents).toBe(11550);
  });

  // O ponto que motiva o teste: com saldo aplicado, o split era PULADO.
  it('a cobrança sai COM split, que era o que o saldo contornava', async () => {
    semearCheckout();
    await checkoutPedindoSaldo();

    const [, body] = pagarme.post.mock.calls[0];
    const split = body.payments[0].split;
    expect(split).toHaveLength(2);
    expect(split.map((s: any) => s.recipient_id)).toEqual(
      expect.arrayContaining(['re_seller', 're_plataforma']),
    );
    // Soma do split == valor cobrado: nada fica fora da divisão.
    expect(split.reduce((t: number, s: any) => t + s.amount, 0)).toBe(11550);
  });
});
