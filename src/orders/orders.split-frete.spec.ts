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
      .mockResolvedValueOnce([endereco]) // endereço de entrega (salvo)
      .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com', cpf: null }]);
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

/**
 * O checkout precisa aceitar os DOIS caminhos: endereço já salvo e endereço
 * digitado na hora. O digitado era descartado — o pedido nascia sem destino, o
 * `billing_address` não era montado e a Pagar.me recusava o cartão inteiro
 * (validation_error | billing). Quem comprava pela primeira vez, sem endereço
 * cadastrado, não conseguia pagar nem escolhendo retirada.
 */
describe('OrdersService — endereço digitado no checkout', () => {
  let service: any;
  let selectChain: any;
  let insertValues: jest.Mock;
  let pagarme: any;

  const digitado = {
    recipientName: 'Artminis Toys',
    street: 'Rua Nova',
    number: '42',
    neighborhood: 'Centro',
    city: 'Santo André',
    state: 'SP',
    zip: '09010-000',
  };

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
    insertValues = jest.fn().mockReturnThis();
    const insertChain: any = {
      values: insertValues,
      returning: jest.fn().mockResolvedValue([
        // Serve tanto ao insert do endereço quanto ao do pedido.
        { id: 'addr_novo', ...digitado, userId: 'user_buyer', country: 'BR' },
      ]),
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
        charges: [{ id: 'ch', last_transaction: { qr_code: 'p', qr_code_url: 'u' } }],
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
            resolveCommissionPercent: jest.fn().mockResolvedValue(COMISSAO_PCT),
          },
        },
      ],
    }).compile();
    service = mod.get(OrdersService);
  });

  it('salva o endereço digitado e usa o id dele no pedido', async () => {
    selectChain.where
      .mockResolvedValueOnce([listing])
      .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
      .mockResolvedValueOnce([]) // o comprador ainda não tem endereço nenhum
      .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com', cpf: null }]);

    await service.createCheckout('user_buyer', {
      items: [{ listingId: 'listing_001' }],
      buyerCpf: '529.982.247-25',
      buyerPhone: '11987654321',
      shippingAddress: digitado, // SEM addressId
      shippingInCents: FRETE,
      deliveryMethod: 'shipping',
    });

    const gravados = insertValues.mock.calls.map((c: any[]) => c[0]);

    // O endereço foi salvo na conta do comprador, com CEP só em dígitos.
    const endereco = gravados.find((v: any) => v?.street === 'Rua Nova');
    expect(endereco).toBeDefined();
    expect(endereco.userId).toBe('user_buyer');
    expect(endereco.zip).toBe('09010000');
    // Primeiro endereço da conta vira o padrão.
    expect(endereco.isDefault).toBe(true);

    // E o pedido aponta para ele — sem isso não há etiqueta.
    const pedido = gravados.find((v: any) => v?.listingId === 'listing_001');
    expect(pedido.addressId).toBe('addr_novo');
  });

  it('recusa endereço salvo que é de outra conta', async () => {
    selectChain.where
      .mockResolvedValueOnce([listing])
      .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
      // Endereço existe, mas pertence a outra pessoa: emitir etiqueta com ele
      // mandaria a peça para a casa dela.
      .mockResolvedValueOnce([{ ...endereco, userId: 'outra_pessoa' }]);

    await expect(
      service.createCheckout('user_buyer', {
        items: [{ listingId: 'listing_001' }],
        buyerCpf: '529.982.247-25',
        buyerPhone: '11987654321',
        addressId: 'addr_1',
        shippingInCents: FRETE,
        deliveryMethod: 'shipping',
      }),
    ).rejects.toThrow(/não pertence à sua conta/i);
  });
});

/**
 * "{"code":"200"}" foi o que sobrou no log de uma compra real recusada — o
 * gateway_response conta se a CHAMADA ao gateway deu certo, não se o emissor
 * autorizou. A decisão vem em acquirer_return_code/acquirer_message.
 */
describe('OrdersService.motivoDaRecusa', () => {
  const chamar = (tx: any) =>
    (new (OrdersService as any)(null, null, null, null, null)).motivoDaRecusa(tx);

  it('traduz o código do adquirente para algo acionável', () => {
    const r = chamar({
      status: 'not_authorized',
      acquirer_return_code: '51',
      acquirer_message: 'Insufficient funds',
      gateway_response: { code: '200', errors: [] },
    });
    expect(r.mensagem).toMatch(/saldo ou limite/i);
    // O log guarda tudo, inclusive o que não viramos mensagem.
    expect(r.log).toContain('not_authorized');
    expect(r.log).toContain('51');
  });

  it('cai na mensagem do adquirente quando o código é desconhecido', () => {
    const r = chamar({
      acquirer_return_code: '99',
      acquirer_message: 'Erro exótico do emissor',
      gateway_response: { code: '200' },
    });
    expect(r.mensagem).toBe('Erro exótico do emissor');
  });

  it('não deixa o comprador sem explicação quando não vem nada', () => {
    const r = chamar({ gateway_response: { code: '200' } });
    expect(r.mensagem).toMatch(/recusado pelo emissor/i);
  });
});

/**
 * O que a Pagar.me recebe alimenta o ANTIFRAUDE. Uma compra real foi reprovada
 * como suspeita mandando: nenhum endereço do comprador, nenhum destino de
 * entrega e um item só, "Compra Kolecta #abc123". Isso tem a cara de teste de
 * cartão.
 */
describe('OrdersService — dados que o antifraude lê', () => {
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
      then: (r: any) => r(undefined),
    };
    const insertChain: any = {
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'order_123', status: 'pending' }]),
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
        status: 'pending',
        charges: [{ id: 'ch', last_transaction: { qr_code: 'p', qr_code_url: 'u' } }],
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
            getOrCreateWallet: jest.fn().mockResolvedValue({ id: 'w', balanceInCents: 0 }),
          },
        },
        { provide: PagarmeService, useValue: pagarme },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: FounderService,
          useValue: { resolveCommissionPercent: jest.fn().mockResolvedValue(COMISSAO_PCT) },
        },
      ],
    }).compile();
    service = mod.get(OrdersService);

    selectChain.where
      .mockResolvedValueOnce([listing])
      .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
      .mockResolvedValueOnce([{ ...endereco, recipientName: 'Artminis Toys' }])
      .mockResolvedValueOnce([{ name: 'Comprador', email: 'b@x.com', cpf: null }]);
  });

  const comprar = () =>
    service.createCheckout('user_buyer', {
      items: [{ listingId: 'listing_001' }],
      buyerCpf: '529.982.247-25',
      buyerPhone: '11987654321',
      addressId: 'addr_1',
      shippingInCents: FRETE,
      deliveryMethod: 'shipping',
    });

  it('discrimina produto e frete, somando exatamente o valor cobrado', async () => {
    await comprar();
    const corpo = pagarme.post.mock.calls[0][1];

    expect(corpo.items).toHaveLength(2);
    expect(corpo.items[0].description).toBe('Hot Wheels'); // título real
    expect(corpo.items[0].amount).toBe(ITEM);
    expect(corpo.items[1].description).toBe('Frete');
    expect(corpo.items[1].amount).toBe(FRETE);
    // A Pagar.me recusa a order se a soma divergir do cobrado.
    expect(corpo.items.reduce((t: number, i: any) => t + i.amount, 0)).toBe(
      ITEM + FRETE,
    );
  });

  it('manda o endereço do comprador', async () => {
    await comprar();
    const c = pagarme.post.mock.calls[0][1].customer;
    expect(c.address).toBeDefined();
    expect(c.address.zip_code).toBe('01310100'); // só dígitos
    expect(c.address.state).toBe('SP');
  });

  /**
   * Testado contra a API: `shipping.amount` SOMA ao total (2553 → 4106). Com
   * ele, o comprador pagaria o frete duas vezes.
   */
  it('manda o destino da entrega SEM amount', async () => {
    await comprar();
    const corpo = pagarme.post.mock.calls[0][1];
    expect(corpo.shipping).toBeDefined();
    expect(corpo.shipping.address.city).toBe('Sao Paulo');
    expect(corpo.shipping.recipient_name).toBe('Artminis Toys');
    expect(corpo.shipping.amount).toBeUndefined();
  });

  it('usa CNPJ quando o comprador é empresa', async () => {
    await service.createCheckout('user_buyer', {
      items: [{ listingId: 'listing_001' }],
      buyerCpf: '11.222.333/0001-81',
      buyerPhone: '11987654321',
      addressId: 'addr_1',
      shippingInCents: FRETE,
      deliveryMethod: 'shipping',
    });
    const c = pagarme.post.mock.calls[0][1].customer;
    expect(c.type).toBe('company');
    expect(c.document_type).toBe('CNPJ');
  });
});
