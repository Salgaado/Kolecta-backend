/**
 * Fail-closed do split (`docs/PLAN-pagarme-conta-nova.md`, Fase 1).
 *
 * Antes, faltar `PAGARME_PLATFORM_RECIPIENT_ID` fazia a compra seguir SEM
 * split: a cobrança caía inteira na conta principal da Kolecta e a divisão
 * existia apenas no ledger da wallet. Um `logger.warn` era o único sinal —
 * dinheiro no lugar errado, sem ninguém perceber até a conciliação.
 *
 * Trocar as credenciais da Pagar.me e esquecer esta variável era suficiente
 * para reproduzir, e é exatamente o que a migração para a conta nova faz.
 *
 * `PLATFORM_RECIPIENT_ID` é lido no carregamento do módulo, por isso a variável
 * é REMOVIDA antes do require — não dá para simular a ausência depois.
 */
delete process.env.PAGARME_PLATFORM_RECIPIENT_ID;
process.env.PAGAMENTO_CARTAO_HABILITADO = 'true';

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ServiceUnavailableException } from '@nestjs/common';
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

describe('OrdersService — sem recebedor da plataforma, a compra é recusada', () => {
  let service: any;
  let selectChain: any;
  let pagarme: any;
  let insertChain: any;

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

    pagarme = { post: jest.fn(), get: jest.fn() };

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

  const checkout = () =>
    service.createCheckout('user_buyer', {
      items: [{ listingId: 'listing_001' }],
      buyerCpf: '529.982.247-25',
      buyerPhone: '11987654321',
      addressId: 'addr_1',
      shippingInCents: 1550,
      deliveryMethod: 'shipping',
    });

  it('recusa a compra em vez de cobrar sem split', async () => {
    semearCheckout();
    await expect(checkout()).rejects.toThrow(ServiceUnavailableException);
  });

  it('não chega a cobrar nada na Pagar.me', async () => {
    semearCheckout();
    await expect(checkout()).rejects.toThrow();

    // O ponto todo: nenhuma cobrança sai sem destino de split definido.
    expect(pagarme.post).not.toHaveBeenCalled();
  });

  it('não deixa pedido órfão no banco', async () => {
    semearCheckout();
    await expect(checkout()).rejects.toThrow();

    // A recusa acontece antes de qualquer escrita — nada a limpar depois.
    expect(insertChain.values).not.toHaveBeenCalled();
  });

  it('a mensagem não vaza detalhe de configuração para o comprador', async () => {
    semearCheckout();
    await expect(checkout()).rejects.toThrow(
      /Não foi possível processar o pagamento agora/,
    );
    // O nome da variável fica no log de erro, não na resposta HTTP.
    await expect(checkout()).rejects.not.toThrow(/PAGARME_/);
  });
});
