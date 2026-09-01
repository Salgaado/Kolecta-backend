/**
 * Frete compartilhado na VENDA DIRETA: recotação no servidor + subsídio.
 *
 * Dois assuntos que andam juntos e por isso são testados juntos:
 *
 * 1. **A recotação** (`docs/PLAN-frete-compartilhado.md`, Fase 1). Até aqui
 *    `shippingInCents` vinha do DTO e era usado direto — o navegador escolhia o
 *    número e o servidor obedecia. Com subsídio a Kolecta passa a pagar parte
 *    de um valor escolhido pelo cliente, e isso deixa de ser aceitável.
 *
 * 2. **O subsídio** (Fase 3). `shipping_in_cents` continua sendo o frete
 *    COBRADO do comprador; o custo cheio e o que a Kolecta bancou vão para as
 *    colunas novas. É essa escolha que mantém `platformFee = comissão +
 *    shippingInCents` correto sem tocar em nenhum dos seis pontos de cálculo —
 *    e é o que o último bloco deste arquivo verifica.
 */
process.env.PAGARME_PLATFORM_RECIPIENT_ID = 're_platform';
process.env.PAGARME_INSTALLMENT_INTEREST = 'off';

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException } from '@nestjs/common';
import { DATABASE_CONNECTION } from '../database/database.module';
import { WalletService } from '../wallet/wallet.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { FounderService } from '../founder/founder.service';
import { ShippingService } from '../shipping/shipping.service';
import { FreteSubsidioService } from '../shipping/frete-subsidio.service';
import { subsidioEmCentavos } from '../common/frete-subsidio';

const { OrdersService } = require('./orders.service');

const COMISSAO_PCT = 11;

/** Item de R$ 300: 7% = R$ 21, acima do frete → frete grátis. */
const ITEM_CARO = 30_000;
/** Item de R$ 120: 7% = R$ 8,40, abaixo do frete → cobertura parcial. */
const ITEM_MEDIO = 12_000;
/** Item de R$ 40: abaixo do piso de R$ 100 → nada. */
const ITEM_BARATO = 4_000;

const PAC = 1_376; // R$ 13,76 — a média real da plataforma
const SEDEX = 4_500;

const POLITICA_LIGADA = {
  ativo: true,
  percentualDoItem: 7,
  tetoEmCentavos: 3_000,
  pisoDoItemEmCentavos: 10_000,
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

const cotacaoReal = {
  pickup: true,
  options: [
    {
      carrier: 'Correios',
      service: 'PAC',
      price: PAC / 100,
      delivery_time_days: 7,
      raw: { id: 1 },
    },
    {
      carrier: 'Correios',
      service: 'SEDEX',
      price: SEDEX / 100,
      delivery_time_days: 2,
      raw: { id: 2 },
    },
  ],
};

describe('OrdersService — frete compartilhado na venda direta', () => {
  let service: any;
  let selectChain: any;
  let insertChain: any;
  let quoteShipping: jest.Mock;
  let pagarme: any;

  const montar = async (opts?: { politicaAtiva?: boolean }) => {
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
    insertChain = {
      values: jest.fn().mockReturnThis(),
      returning: jest
        .fn()
        .mockResolvedValue([{ id: 'order_123', status: 'pending' }]),
    };
    const db = {
      select: () => selectChain,
      update: () => updateChain,
      insert: () => insertChain,
      query: {
        addresses: { findFirst: jest.fn().mockResolvedValue(endereco) },
      },
      transaction: jest.fn(async (cb: any) =>
        cb({ update: () => updateChain, insert: () => insertChain }),
      ),
    };

    quoteShipping = jest.fn().mockResolvedValue(cotacaoReal);

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

    // O serviço de subsídio REAL, com a política passada por parâmetro — é o
    // caminho que vai para produção, não um dublê que confirma o que quisermos.
    const freteSubsidio = new FreteSubsidioService(db as any);
    jest
      .spyOn(freteSubsidio, 'politica')
      .mockReturnValue(
        opts?.politicaAtiva
          ? POLITICA_LIGADA
          : { ...POLITICA_LIGADA, ativo: false },
      );

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
        { provide: ShippingService, useValue: { quoteShipping } },
        { provide: FreteSubsidioService, useValue: freteSubsidio },
      ],
    }).compile();

    service = mod.get(OrdersService);
  };

  const semear = (itemInCents: number) => {
    selectChain.where
      .mockResolvedValueOnce([
        {
          id: 'listing_001',
          sellerId: 'user_seller',
          title: 'Hot Wheels',
          status: 'active',
          priceInCents: itemInCents,
        },
      ])
      .mockResolvedValueOnce([{ recipientId: 're_seller', canReceive: true }])
      .mockResolvedValueOnce([endereco])
      .mockResolvedValueOnce([
        { name: 'Comprador', email: 'b@x.com', cpf: null },
      ]);
  };

  const comprar = (over: any = {}) =>
    service.createCheckout('user_buyer', {
      items: [{ listingId: 'listing_001' }],
      buyerCpf: '529.982.247-25',
      buyerPhone: '11987654321',
      addressId: 'addr_1',
      deliveryMethod: 'shipping',
      shippingServiceId: 1,
      shippingInCents: PAC,
      ...over,
    });

  /** O que foi efetivamente gravado em `orders`. */
  const gravado = () => insertChain.values.mock.calls[0][0];

  // ── Fase 1: a recotação ───────────────────────────────────────────────────

  describe('recotação no servidor', () => {
    it('recota e usa o preço do SERVIDOR, não o que o navegador declarou', async () => {
      await montar();
      semear(ITEM_CARO);

      // O cliente declara R$ 13,76 e o servidor confirma R$ 13,76.
      await comprar();

      expect(quoteShipping).toHaveBeenCalledWith(
        expect.objectContaining({
          to_cep: '01310100',
          listing_id: 'listing_001',
        }),
      );
      expect(gravado().shippingInCents).toBe(PAC);
    });

    it('grava a transportadora da COTAÇÃO, não a que veio no DTO', async () => {
      await montar();
      semear(ITEM_CARO);

      await comprar({ shippingServiceName: 'Nome inventado pelo cliente' });

      expect(gravado().shippingServiceId).toBe(1);
      expect(gravado().shippingServiceName).toBe('Correios PAC');
    });

    it('recusa opção de frete que não existe mais para o destino', async () => {
      await montar();
      semear(ITEM_CARO);

      // Serviço 99 não está na cotação.
      await expect(comprar({ shippingServiceId: 99 })).rejects.toThrow(
        BadRequestException,
      );
      expect(insertChain.values).not.toHaveBeenCalled();
    });

    it('recusa quando o servidor cota MAIS CARO que o declarado, acima da folga', async () => {
      await montar();
      semear(ITEM_CARO);

      // Cliente declarou R$ 5,00 para um frete que custa R$ 13,76.
      await expect(comprar({ shippingInCents: 500 })).rejects.toThrow(
        /preço do frete mudou/i,
      );
      expect(insertChain.values).not.toHaveBeenCalled();
    });

    it('aceita divergência de centavos (oscilação do Melhor Envio)', async () => {
      await montar();
      semear(ITEM_CARO);

      // R$ 13,50 declarado contra R$ 13,76 cotado: R$ 0,26 de folga.
      await comprar({ shippingInCents: PAC - 26 });

      expect(gravado().shippingInCents).toBe(PAC - 26);
    });

    it('servidor MAIS BARATO: o comprador leva o menor, sem recusa', async () => {
      await montar();
      semear(ITEM_CARO);

      // Cliente declarou R$ 30 e o servidor cotou R$ 13,76.
      await comprar({ shippingInCents: 3_000 });

      expect(gravado().shippingInCents).toBe(PAC);
    });

    it('cotação indisponível (mock/ME fora): cobra o declarado e NÃO subsidia', async () => {
      await montar({ politicaAtiva: true });
      semear(ITEM_CARO);
      // Mock do ShippingService não tem `raw.id`.
      quoteShipping.mockResolvedValueOnce({
        pickup: true,
        options: [
          { carrier: 'Correios', service: 'PAC', price: 25.9, raw: {} },
        ],
      });

      await comprar();

      expect(gravado().shippingInCents).toBe(PAC);
      expect(gravado().shippingSubsidyInCents).toBe(0);
    });

    it('recotação que explode não derruba o checkout — só fecha o subsídio', async () => {
      await montar({ politicaAtiva: true });
      semear(ITEM_CARO);
      quoteShipping.mockRejectedValueOnce(new Error('Melhor Envio fora do ar'));

      await comprar();

      expect(gravado().shippingInCents).toBe(PAC);
      expect(gravado().shippingSubsidyInCents).toBe(0);
    });

    it('cliente antigo, sem transportadora no DTO: segue sem subsídio', async () => {
      await montar({ politicaAtiva: true });
      semear(ITEM_CARO);

      await comprar({ shippingServiceId: undefined });

      expect(gravado().shippingInCents).toBe(PAC);
      expect(gravado().shippingSubsidyInCents).toBe(0);
    });
  });

  // ── Fase 3: o subsídio ────────────────────────────────────────────────────

  describe('política DESLIGADA (o default)', () => {
    it('o comprador paga o frete cheio e nada é subsidiado', async () => {
      await montar();
      semear(ITEM_CARO);

      await comprar();

      expect(gravado().shippingInCents).toBe(PAC);
      expect(gravado().shippingCostInCents).toBe(PAC);
      expect(gravado().shippingSubsidyInCents).toBe(0);
    });
  });

  describe('política LIGADA', () => {
    it('item caro: frete grátis, e o comprador paga só o item', async () => {
      await montar({ politicaAtiva: true });
      semear(ITEM_CARO);

      await comprar();

      expect(gravado().shippingInCents).toBe(0);
      expect(gravado().shippingCostInCents).toBe(PAC);
      expect(gravado().shippingSubsidyInCents).toBe(PAC);
      expect(gravado().totalInCents).toBe(ITEM_CARO);
    });

    it('item médio: cobertura parcial de 7% do item', async () => {
      await montar({ politicaAtiva: true });
      semear(ITEM_MEDIO);

      await comprar();

      const esperado = Math.round(ITEM_MEDIO * 0.07); // R$ 8,40
      expect(gravado().shippingSubsidyInCents).toBe(esperado);
      expect(gravado().shippingInCents).toBe(PAC - esperado);
      expect(gravado().shippingCostInCents).toBe(PAC);
    });

    it('item abaixo de R$ 100: nada, e o comprador paga o frete inteiro', async () => {
      await montar({ politicaAtiva: true });
      semear(ITEM_BARATO);

      await comprar();

      expect(gravado().shippingSubsidyInCents).toBe(0);
      expect(gravado().shippingInCents).toBe(PAC);
    });

    it('a âncora é a opção MAIS BARATA: escolher SEDEX não aumenta o subsídio', async () => {
      await montar({ politicaAtiva: true });
      semear(ITEM_MEDIO);

      await comprar({ shippingServiceId: 2, shippingInCents: SEDEX });

      // 7% de R$ 120 = R$ 8,40, ancorado no PAC — não no SEDEX.
      const esperado = Math.round(ITEM_MEDIO * 0.07);
      expect(gravado().shippingSubsidyInCents).toBe(esperado);
      // A diferença do SEDEX é INTEIRA do comprador.
      expect(gravado().shippingInCents).toBe(SEDEX - esperado);
      expect(gravado().shippingServiceName).toBe('Correios SEDEX');
    });

    it('retirada em mãos: sem frete, sem etiqueta, sem subsídio', async () => {
      await montar({ politicaAtiva: true });
      selectChain.where
        .mockResolvedValueOnce([
          {
            id: 'listing_001',
            sellerId: 'user_seller',
            title: 'Hot Wheels',
            status: 'active',
            priceInCents: ITEM_CARO,
          },
        ])
        .mockResolvedValueOnce([
          { recipientId: 're_seller', canReceive: true, acceptsPickup: true },
        ])
        .mockResolvedValueOnce([endereco])
        .mockResolvedValueOnce([
          { name: 'Comprador', email: 'b@x.com', cpf: null },
        ]);

      await comprar({ deliveryMethod: 'pickup', shippingInCents: 0 });

      expect(gravado().shippingInCents).toBe(0);
      expect(gravado().shippingCostInCents).toBe(0);
      expect(gravado().shippingSubsidyInCents).toBe(0);
      expect(gravado().shippingServiceId).toBeNull();
      expect(quoteShipping).not.toHaveBeenCalled();
    });
  });

  // ── As invariantes que substituem o PaymentsService ───────────────────────

  describe('invariantes do caminho do dinheiro', () => {
    const casos = [
      { nome: 'item caro (frete grátis)', item: ITEM_CARO },
      { nome: 'item médio (parcial)', item: ITEM_MEDIO },
      { nome: 'item barato (inelegível)', item: ITEM_BARATO },
    ];

    for (const caso of casos) {
      it(`${caso.nome}: cost == shipping + subsidy`, async () => {
        await montar({ politicaAtiva: true });
        semear(caso.item);

        await comprar();

        const g = gravado();
        expect(g.shippingCostInCents).toBe(
          g.shippingInCents + g.shippingSubsidyInCents,
        );
        expect(g.shippingCostInCents).toBe(PAC);
      });

      it(`${caso.nome}: o split confere com platformFee = comissão + frete cobrado`, async () => {
        await montar({ politicaAtiva: true });
        semear(caso.item);

        await comprar();

        const g = gravado();
        const corpo = pagarme.post.mock.calls[0][1];
        const split = corpo.payments[0].split;
        const kolecta = split.find(
          (s: any) => s.recipient_id === 're_platform',
        );
        const vendedor = split.find((s: any) => s.recipient_id === 're_seller');

        const comissao = Math.round((caso.item * COMISSAO_PCT) / 100);

        // A igualdade que o desenho das colunas protege.
        expect(kolecta.amount).toBe(comissao + g.shippingInCents);
        // E nada se perde no caminho.
        expect(vendedor.amount + kolecta.amount).toBe(g.totalInCents);
      });

      it(`${caso.nome}: o VENDEDOR recebe o mesmo com ou sem subsídio`, async () => {
        await montar({ politicaAtiva: true });
        semear(caso.item);
        await comprar();
        const comSubsidio =
          pagarme.post.mock.calls[0][1].payments[0].split.find(
            (s: any) => s.recipient_id === 're_seller',
          ).amount;

        await montar({ politicaAtiva: false });
        semear(caso.item);
        await comprar();
        const semSubsidio =
          pagarme.post.mock.calls[0][1].payments[0].split.find(
            (s: any) => s.recipient_id === 're_seller',
          ).amount;

        // É a promessa da política ao vendedor, e é a que não pode quebrar.
        expect(comSubsidio).toBe(semSubsidio);
        expect(comSubsidio).toBe(
          caso.item - Math.round((caso.item * COMISSAO_PCT) / 100),
        );
      });
    }

    it('o comprador nunca paga mais do que pagaria sem a política', async () => {
      for (const item of [ITEM_BARATO, ITEM_MEDIO, ITEM_CARO]) {
        await montar({ politicaAtiva: true });
        semear(item);
        await comprar();
        const com = gravado().totalInCents;

        await montar({ politicaAtiva: false });
        semear(item);
        await comprar();
        const sem = gravado().totalInCents;

        expect(com).toBeLessThanOrEqual(sem);
        expect(sem - com).toBe(subsidioEmCentavos(item, PAC, POLITICA_LIGADA));
      }
    });
  });
});
