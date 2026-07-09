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
    // 1ª = comprador; 2ª = vendedor
    db.query.users.findFirst
      .mockResolvedValueOnce({ email: 'b@x.com', name: 'Comprador' })
      .mockResolvedValueOnce({ email: 's@x.com', name: 'Vendedor' });
    db.query.listings.findFirst.mockResolvedValue({ title: 'Hot Wheels RLC' });
    httpPost.mockReturnValue(of({ data: { id: 123, protocol: 'ORD-XYZ' } }));
  }

  it('monta o payload /cart (service, from/to, volumes, valor declarado) e headers Bearer', async () => {
    seedHappyPath();
    const service = new ShippingService(http, db as any);

    const result = await service.generateLabel(dto);

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
    expect(result.panelUrl).toContain('/painel/carrinho');
  });

  it('respeita declared_value do request quando informado', async () => {
    seedHappyPath();
    const service = new ShippingService(http, db as any);

    await service.generateLabel({ ...dto, declared_value: 999.5 });

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

  it('vendedor dono do pedido → gera normalmente', async () => {
    seedHappyPath(); // order.sellerId === 'seller-1'
    const service = new ShippingService(http, db as any);

    const result = await service.generateLabel(dto, 'seller-1');

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
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
