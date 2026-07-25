/**
 * O frete vai para a KOLECTA no split, não para o vendedor.
 *
 * Quem compra a etiqueta no Melhor Envio é a Kolecta (o token é da plataforma,
 * o vendedor não tem acesso à conta). Enquanto o split mandava o frete ao
 * vendedor, a Kolecta pagava o frete DUAS vezes: repassava o valor e ainda
 * comprava a etiqueta.
 *
 * O exemplo do dono, que é o caso de teste abaixo:
 *   item R$ 100,00 + frete R$ 15,50 → comprador paga R$ 115,50
 *   vendedor recebe R$ 89,00  (100 − 11%)
 *   Kolecta  recebe R$ 26,50  (11,00 de comissão + 15,50 de frete)
 *
 * `PLATFORM_RECIPIENT_ID` é lido no carregamento do módulo, por isso o env é
 * definido ANTES do require (mesmo padrão de orders.installments.spec.ts).
 */
process.env.PAGARME_PLATFORM_RECIPIENT_ID = 're_platform';
// Sem juros: o teste é sobre o frete, não sobre parcelamento.
process.env.PAGARME_INSTALLMENT_INTEREST = 'off';

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DATABASE_CONNECTION } from '../database/database.module';
import { WalletService } from '../wallet/wallet.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { FounderService } from '../founder/founder.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OrdersService } = require('./orders.service');

const ITEM = 10000; // R$ 100,00
const FRETE = 1550; // R$ 15,50
const COMISSAO_PCT = 11;

const listing = {
  id: 'listing_001',
  sellerId: 'user_seller',
  title: 'Hot Wheels',
  status: 'active',
  priceInCents: ITEM,
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

describe('OrdersService — frete no split vai para a Kolecta', () => {
  let service: any;
  let selectChain: any;
  let pagarme: any;

  beforeEach(async () => {
    selectChain = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn(),
    };
    const updateChain: any = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'order_123' }]),
      then: (resolve: any) => resolve(undefined),
    };
    const insertChain = {
      values: jest.fn().mockReturnThis(),
      returning: jest
        .fn()
        .mockResolvedValue([{ id: 'order_123', status: 'pending' }]),
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
        id: 'or_test',
        status: 'pending',
        charges: [
          {
            id: 'ch_test',
            last_transaction: { qr_code: 'pix', qr_code_url: 'u' },
          },
        ],
      }),
      get: jest.fn(),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: DATABASE_CONNECTION, useValue: db },
        {
          provide: WalletService,
          useValue: {
            hold: jest.fn(),
            getOrCreateWallet: jest
              .fn()
              .mockResolvedValue({ id: 'w1', balanceInCents: 0 }),
          },
        },
        { provide: PagarmeService, useValue: pagarme },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: FounderService,
          useValue: {
            resolveCommissionPercent: jest
              .fn()
              .mockResolvedValue(COMISSAO_PCT),
          },
        },
      ],
    }).compile();

    service = mod.get(OrdersService);
  });

  const semearCheckout = () => {
    selectChain.where
      .mockResolvedValueOnce([listing]) // listing
      .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
      .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com', cpf: null }])
      .mockResolvedValueOnce([endereco]);
  };

  it('vendedor fica só com o item menos a comissão; frete + comissão vão para a Kolecta', async () => {
    semearCheckout();

    await service.createCheckout('user_buyer', {
      items: [{ listingId: 'listing_001' }],
      buyerCpf: '529.982.247-25',
      buyerPhone: '11987654321',
      addressId: 'addr_1',
      shippingInCents: FRETE,
      deliveryMethod: 'shipping',
    });

    const corpo = pagarme.post.mock.calls[0][1];
    const split = corpo.payments[0].split;
    expect(split).toBeDefined();

    const vendedor = split.find((s: any) => s.recipient_id === 're_seller');
    const kolecta = split.find((s: any) => s.recipient_id === 're_platform');

    // Comprador pagou 115,50.
    expect(corpo.items.reduce((t: number, i: any) => t + i.amount, 0)).toBe(
      ITEM + FRETE,
    );
    // Vendedor: 100 − 11% = 89,00. O frete NÃO entra.
    expect(vendedor.amount).toBe(8900);
    // Kolecta: 11,00 de comissão + 15,50 de frete = 26,50.
    expect(kolecta.amount).toBe(2650);
    // Nada se perde nem se cria no caminho.
    expect(vendedor.amount + kolecta.amount).toBe(ITEM + FRETE);
  });

  it('em retirada em mãos não há frete: só a comissão vai para a Kolecta', async () => {
    semearCheckout();

    await service.createCheckout('user_buyer', {
      items: [{ listingId: 'listing_001' }],
      buyerCpf: '529.982.247-25',
      buyerPhone: '11987654321',
      addressId: 'addr_1',
      shippingInCents: FRETE, // ignorado: pickup zera o frete
      deliveryMethod: 'pickup',
    });

    const split = pagarme.post.mock.calls[0][1].payments[0].split;
    const vendedor = split.find((s: any) => s.recipient_id === 're_seller');
    const kolecta = split.find((s: any) => s.recipient_id === 're_platform');

    expect(vendedor.amount).toBe(8900);
    expect(kolecta.amount).toBe(1100);
  });
});
