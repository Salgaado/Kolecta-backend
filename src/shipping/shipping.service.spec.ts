import { of } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import {
  HttpException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ShippingService } from './shipping.service';
import { GenerateLabelDto } from './dto/shipping.dto';

const BASE = 'https://sandbox.melhorenvio.com.br/api/v2/me';

// Mock do client Drizzle (API relacional `db.query.*.findFirst`).
function makeDb() {
  return {
    query: {
      orders: { findFirst: jest.fn() },
      addresses: { findFirst: jest.fn() },
      users: { findFirst: jest.fn() },
      listings: { findFirst: jest.fn() },
    },
  };
}

const toAddress = {
  id: 'addr-to',
  recipientName: 'Comprador',
  street: 'Rua A',
  number: '10',
  complement: null,
  neighborhood: 'Centro',
  city: 'São Paulo',
  state: 'SP',
  zip: '01001-000',
  country: 'BR',
};

const fromAddress = {
  id: 'addr-from',
  recipientName: 'Vendedor',
  street: 'Rua B',
  number: '20',
  complement: 'Sala 2',
  neighborhood: 'Copacabana',
  city: 'Rio de Janeiro',
  state: 'RJ',
  zip: '22000-000',
  country: 'BR',
};

const order = {
  id: 'ord-1',
  addressId: 'addr-to',
  buyerId: 'buyer-1',
  sellerId: 'seller-1',
  listingId: 'lst-1',
  totalInCents: 15000,
};

const dto: GenerateLabelDto = {
  order_id: 'ord-1',
  service_id: 2,
  origin_address_id: 'addr-from',
  volumes: { weight_kg: 0.5, width_cm: 20, height_cm: 10, length_cm: 30 },
};

describe('ShippingService — geração de etiqueta (POST /me/cart)', () => {
  let httpPost: jest.Mock;
  let http: HttpService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    process.env.MELHOR_ENVIO_API_URL = BASE;
    process.env.MELHOR_ENVIO_TOKEN = 'test-token';
    httpPost = jest.fn();
    http = { post: httpPost } as unknown as HttpService;
    db = makeDb();
  });

  function seedHappyPath() {
    db.query.orders.findFirst.mockResolvedValue(order);
    // 1ª chamada = destino (order.addressId); 2ª = origem (origin_address_id)
    db.query.addresses.findFirst
      .mockResolvedValueOnce(toAddress)
      .mockResolvedValueOnce(fromAddress);
    // 1ª = comprador; 2ª = vendedor. O CPF é obrigatório: o Melhor Envio exige
    // documento nas duas pontas e recusa o carrinho inteiro sem ele.
    db.query.users.findFirst
      .mockResolvedValueOnce({
        email: 'b@x.com',
        name: 'Comprador',
        cpf: '52998224725',
      })
      .mockResolvedValueOnce({
        email: 's@x.com',
        name: 'Vendedor',
        cpf: '11144477735',
      });
    db.query.listings.findFirst.mockResolvedValue({ title: 'Hot Wheels RLC' });
    httpPost.mockReturnValue(of({ data: { id: 123, protocol: 'ORD-XYZ' } }));
  }

  it('monta o payload /cart (service, from/to, volumes, valor declarado) e headers Bearer', async () => {
    seedHappyPath();
    const service = new ShippingService(http, db as any);

    // `createCart` e nao `generateLabel`: a montagem do payload continua a
    // mesma, mas quem a dispara agora e a emissao automatica.
    const result = await (service as any).createCart(dto);

    expect(httpPost).toHaveBeenCalledTimes(1);
    const [url, payload, config] = httpPost.mock.calls[0];

    expect(url).toBe(`${BASE}/cart`);
    expect(payload.service).toBe(2);
    // CEPs sem máscara
    expect(payload.to.postal_code).toBe('01001000');
    expect(payload.from.postal_code).toBe('22000000');
    expect(payload.to.name).toBe('Comprador');
    expect(payload.from.state_abbr).toBe('RJ');
    // valor declarado = total do pedido (15000 centavos → 150)
    expect(payload.products[0].unitary_value).toBe(150);
    expect(payload.options.insurance_value).toBe(150);
    // volume repassado
    expect(payload.volumes[0]).toEqual({
      height: 10,
      width: 20,
      length: 30,
      weight: 0.5,
    });
    // auth
    expect(config.headers.Authorization).toBe('Bearer test-token');

    expect(result).toMatchObject({
      success: true,
      cartId: 123,
      protocol: 'ORD-XYZ',
    });
    // `/carrinho` e NÃO `/painel/carrinho`: a segunda rota não existe no Melhor
    // Envio e devolve "não encontrado" com HTTP 200 — o vendedor caía num 404.
    expect(result.panelUrl).toContain('/carrinho');
    expect(result.panelUrl).not.toContain('/painel/');
  });

  it('respeita declared_value do request quando informado', async () => {
    seedHappyPath();
    const service = new ShippingService(http, db as any);

    await (service as any).createCart({ ...dto, declared_value: 999.5 });

    const payload = httpPost.mock.calls[0][1];
    expect(payload.products[0].unitary_value).toBe(999.5);
    expect(payload.options.insurance_value).toBe(999.5);
  });

  it('sem MELHOR_ENVIO_TOKEN → falha visível (não mock)', async () => {
    delete process.env.MELHOR_ENVIO_TOKEN;
    const service = new ShippingService(http, db as any);

    await expect(service.generateLabel(dto)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('pedido inexistente → NotFoundException', async () => {
    db.query.orders.findFirst.mockResolvedValue(undefined);
    const service = new ShippingService(http, db as any);

    await expect(service.generateLabel(dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('vendedor que não é dono do pedido → ForbiddenException', async () => {
    db.query.orders.findFirst.mockResolvedValue(order); // sellerId: 'seller-1'
    const service = new ShippingService(http, db as any);

    await expect(
      service.generateLabel(dto, 'outro-vendedor'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(httpPost).not.toHaveBeenCalled();
  });

  /**
   * Quem escolhe a forma de envio e o COMPRADOR, no checkout — e e ela que ele
   * paga. O botao do vendedor recotava e deixava escolher outro servico, o que
   * permitia despachar diferente do cobrado E criava um segundo carrinho
   * (carteira da Kolecta debitada duas vezes pelo mesmo pedido).
   */
  it('vendedor dono do pedido → delega para a emissão e IGNORA o serviço do corpo', async () => {
    seedHappyPath(); // order.sellerId === 'seller-1'
    const service = new ShippingService(http, db as any);
    const emissao = jest
      .spyOn(service, 'emitirEtiquetaDoPedido')
      .mockResolvedValue({
        status: 'ready',
        cartId: 'cart-1',
        labelUrl: 'https://me/etiqueta.pdf',
        trackingCode: null,
        jaEstavaPronta: false,
      });

    await service.generateLabel({ ...dto, service_id: 999 }, 'seller-1');

    expect(emissao).toHaveBeenCalledWith('ord-1');
    // Nada foi montado com o service_id do corpo.
    expect(httpPost).not.toHaveBeenCalled();
  });
});

describe('ShippingService — cotação (POST /shipment/calculate)', () => {
  let httpPost: jest.Mock;
  let http: HttpService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    process.env.MELHOR_ENVIO_API_URL = BASE;
    process.env.MELHOR_ENVIO_TOKEN = 'test-token';
    delete process.env.SHIPPING_ORIGIN_CEP;
    httpPost = jest.fn();
    http = { post: httpPost } as unknown as HttpService;
    db = makeDb();
  });

  it('resolve origem pelo endereço do vendedor (via listing) e aplica defaults de pacote', async () => {
    db.query.listings.findFirst.mockResolvedValue({ sellerId: 'seller-1' });
    db.query.addresses.findFirst.mockResolvedValue({ zip: '22000-000' });
    httpPost.mockReturnValue(
      of({
        data: [
          {
            company: { name: 'Correios' },
            name: 'PAC',
            price: '25.90',
            delivery_time: 7,
            id: 1,
          },
        ],
      }),
    );
    const service = new ShippingService(http, db as any);

    const result = await service.quoteShipping({
      to_cep: '01001-000',
      listing_id: 'lst-1',
    } as any);

    const [url, payload] = httpPost.mock.calls[0];
    expect(url).toBe(`${BASE}/shipment/calculate`);
    expect(payload.from.postal_code).toBe('22000000'); // origem do vendedor
    expect(payload.to.postal_code).toBe('01001000');
    expect(payload.package.weight).toBe(0.3); // default de colecionável
    expect(payload.package.width).toBe(16);
    expect(result.options[0]).toMatchObject({
      carrier: 'Correios',
      service: 'PAC',
      price: 25.9,
    });
  });

  it('usa peso/dimensões persistidos no anúncio quando existem', async () => {
    db.query.listings.findFirst.mockResolvedValue({
      sellerId: 'seller-1',
      weightGrams: 800,
      widthCm: 25,
      heightCm: 15,
      lengthCm: 40,
    });
    db.query.addresses.findFirst.mockResolvedValue({ zip: '22000-000' });
    httpPost.mockReturnValue(of({ data: [] }));
    const service = new ShippingService(http, db as any);

    await service.quoteShipping({
      to_cep: '01001000',
      listing_id: 'lst-1',
    } as any);

    const payload = httpPost.mock.calls[0][1];
    expect(payload.package).toEqual({
      weight: 0.8, // 800 g → 0,8 kg
      width: 25,
      height: 15,
      length: 40,
    });
  });

  it('request sobrepõe as medidas do anúncio', async () => {
    db.query.listings.findFirst.mockResolvedValue({
      sellerId: 'seller-1',
      weightGrams: 800,
      widthCm: 25,
      heightCm: 15,
      lengthCm: 40,
    });
    db.query.addresses.findFirst.mockResolvedValue({ zip: '22000-000' });
    httpPost.mockReturnValue(of({ data: [] }));
    const service = new ShippingService(http, db as any);

    await service.quoteShipping({
      to_cep: '01001000',
      listing_id: 'lst-1',
      weight_kg: 2,
      width_cm: 50,
    } as any);

    const payload = httpPost.mock.calls[0][1];
    expect(payload.package.weight).toBe(2); // request vence
    expect(payload.package.width).toBe(50); // request vence
    expect(payload.package.height).toBe(15); // anúncio preenche o resto
  });

  it('sem token → mock', async () => {
    delete process.env.MELHOR_ENVIO_TOKEN;
    const service = new ShippingService(http, db as any);

    const result = await service.quoteShipping({ to_cep: '01001000' } as any);

    expect(httpPost).not.toHaveBeenCalled();
    expect(result.options.length).toBeGreaterThan(0);
  });

  it('sem origem resolvível → mock (não cota)', async () => {
    const service = new ShippingService(http, db as any);

    const result = await service.quoteShipping({ to_cep: '01001000' } as any);

    expect(httpPost).not.toHaveBeenCalled();
    expect(result.options.length).toBeGreaterThan(0);
  });
});

/**
 * Emissão automática (cart → checkout → generate → print).
 *
 * O que está sendo protegido aqui não é o "caminho feliz" — é o contrário:
 * cada `checkout` debita dinheiro real da carteira da Kolecta, e cada etiqueta
 * errada manda a peça de alguém para o endereço de outra pessoa.
 */
describe('ShippingService — emissão automática da etiqueta', () => {
  const BASE_URL = 'https://sandbox.melhorenvio.com.br/api/v2/me';

  const pedidoPago = {
    id: 'ord-1',
    addressId: 'addr-to',
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    listingId: 'lst-1',
    totalInCents: 15000,
    status: 'paid',
    deliveryMethod: 'shipping',
    shippingServiceId: 2,
    shippingCartId: null,
    shippingLabelStatus: null,
    shippingLabelUrl: null,
  };

  const fazerDb = (over: Record<string, any> = {}) => {
    const db: any = {
      query: {
        orders: { findFirst: jest.fn().mockResolvedValue(pedidoPago) },
        addresses: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ ...toAddress, userId: 'buyer-1' }),
        },
        users: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({
              email: 'b@x.com',
              name: 'Comprador',
              cpf: '52998224725',
            })
            .mockResolvedValueOnce({
              email: 's@x.com',
              name: 'Vendedor',
              cpf: '11144477735',
            }),
        },
        listings: {
          findFirst: jest.fn().mockResolvedValue({ title: 'Hot Wheels RLC' }),
        },
      },
      ...over,
    };
    // enderecoDoVendedor: select().from().where()
    db.select = jest.fn().mockReturnValue(db);
    db.from = jest.fn().mockReturnValue(db);
    db.where = jest
      .fn()
      .mockResolvedValue([{ ...fromAddress, userId: 'seller-1', isDefault: true }]);
    // registrarEtiqueta: update().set().where()
    db.updateWhere = jest.fn().mockResolvedValue(undefined);
    db.update = jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((patch: any) => {
        db.patches.push(patch);
        return { where: db.updateWhere };
      }),
    });
    db.patches = [] as any[];
    return db;
  };

  beforeEach(() => {
    process.env.MELHOR_ENVIO_API_URL = BASE_URL;
    process.env.MELHOR_ENVIO_TOKEN = 'test-token';
  });

  it('não gasta de novo quando a etiqueta já está pronta', async () => {
    const db = fazerDb();
    db.query.orders.findFirst.mockResolvedValue({
      ...pedidoPago,
      shippingLabelStatus: 'ready',
      shippingLabelUrl: 'https://me/etiqueta.pdf',
      shippingCartId: 'cart-1',
    });
    const httpPost = jest.fn();
    const service = new ShippingService(
      { post: httpPost } as any,
      db as any,
    );

    const r = await service.emitirEtiquetaDoPedido('ord-1');

    expect(r.jaEstavaPronta).toBe(true);
    // Nenhuma chamada: repetir o checkout debitaria a carteira outra vez.
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('recusa quando o endereço de entrega não é do comprador do pedido', async () => {
    const db = fazerDb();
    db.query.addresses.findFirst.mockResolvedValue({
      ...toAddress,
      userId: 'outra-pessoa',
    });
    const httpPost = jest.fn();
    const service = new ShippingService({ post: httpPost } as any, db as any);

    await expect(service.emitirEtiquetaDoPedido('ord-1')).rejects.toThrow(
      /não pertence ao comprador/i,
    );
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('recusa pedido de retirada em mãos', async () => {
    const db = fazerDb();
    db.query.orders.findFirst.mockResolvedValue({
      ...pedidoPago,
      deliveryMethod: 'pickup',
    });
    const httpPost = jest.fn();
    const service = new ShippingService({ post: httpPost } as any, db as any);

    await expect(service.emitirEtiquetaDoPedido('ord-1')).rejects.toThrow(
      /retirada em mãos/i,
    );
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('recusa pedido que ainda não foi pago', async () => {
    const db = fazerDb();
    db.query.orders.findFirst.mockResolvedValue({
      ...pedidoPago,
      status: 'pending_payment',
    });
    const service = new ShippingService({ post: jest.fn() } as any, db as any);

    await expect(service.emitirEtiquetaDoPedido('ord-1')).rejects.toThrow(
      /ainda não está pago/i,
    );
  });

  it('recusa quando o vendedor não tem endereço de origem', async () => {
    const db = fazerDb();
    db.where.mockResolvedValue([]);
    const service = new ShippingService({ post: jest.fn() } as any, db as any);

    await expect(service.emitirEtiquetaDoPedido('ord-1')).rejects.toThrow(
      /endereço de origem/i,
    );
  });

  it('percorre cart → checkout → generate → print e grava o resultado', async () => {
    const db = fazerDb();
    const httpPost = jest.fn().mockImplementation((url: string) => {
      if (url.endsWith('/cart')) return of({ data: { id: 'cart-9' } });
      if (url.endsWith('/shipment/print'))
        return of({ data: { url: 'https://me/etiqueta.pdf' } });
      if (url.endsWith('/shipment/tracking'))
        return of({ data: { 'cart-9': { tracking: 'BR123' } } });
      return of({ data: {} });
    });
    const service = new ShippingService({ post: httpPost } as any, db as any);

    const r = await service.emitirEtiquetaDoPedido('ord-1');

    const chamadas = httpPost.mock.calls.map((c: any[]) => c[0]);
    expect(chamadas).toEqual([
      `${BASE_URL}/cart`,
      `${BASE_URL}/shipment/checkout`,
      `${BASE_URL}/shipment/generate`,
      `${BASE_URL}/shipment/print`,
      `${BASE_URL}/shipment/tracking`,
    ]);
    expect(r.status).toBe('ready');
    expect(r.labelUrl).toBe('https://me/etiqueta.pdf');
    expect(r.trackingCode).toBe('BR123');

    const final = db.patches[db.patches.length - 1];
    expect(final.shippingLabelStatus).toBe('ready');
    expect(final.trackingCode).toBe('BR123');
  });

  /**
   * Saldo zerado na carteira do Melhor Envio cai exatamente aqui. O motivo tem
   * que sobrar escrito: "Falha ao gerar etiqueta" sem razão já custou tempo.
   */
  it('grava o motivo quando o Melhor Envio recusa o checkout', async () => {
    const db = fazerDb();
    const httpPost = jest.fn().mockImplementation((url: string) => {
      if (url.endsWith('/cart')) return of({ data: { id: 'cart-9' } });
      if (url.endsWith('/shipment/checkout')) {
        const erro: any = new Error('Request failed');
        erro.response = { data: { message: 'Saldo insuficiente' }, status: 400 };
        throw erro;
      }
      return of({ data: {} });
    });
    const service = new ShippingService({ post: httpPost } as any, db as any);

    await expect(service.emitirEtiquetaDoPedido('ord-1')).rejects.toThrow(
      /Saldo insuficiente/,
    );

    const final = db.patches[db.patches.length - 1];
    expect(final.shippingLabelStatus).toBe('failed');
    expect(final.shippingLabelError).toBe('Saldo insuficiente');
    // O carrinho já criado fica gravado: retomar não pode criar outro.
    expect(db.patches.some((p: any) => p.shippingCartId === 'cart-9')).toBe(true);
  });
});
