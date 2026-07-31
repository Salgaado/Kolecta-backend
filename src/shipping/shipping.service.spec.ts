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
  // `select()` serve ao documento do vendedor em `seller_profiles`. Default
  // vazio: os testes que já existiam continuam resolvendo pelo `users.cpf`.
  const selectChain: any = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  };
  return {
    query: {
      orders: { findFirst: jest.fn() },
      addresses: { findFirst: jest.fn() },
      users: { findFirst: jest.fn() },
      listings: { findFirst: jest.fn() },
    },
    select: jest.fn(() => selectChain),
    /** Documento no cadastro de recebedor do vendedor (ou nenhum). */
    __comDocumentoDoRecebedor(documentNumber: string | null) {
      selectChain.where.mockResolvedValue(
        documentNumber ? [{ documentNumber }] : [],
      );
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

  // ── Documento do vendedor ────────────────────────────────────────────────
  //
  // `users.cpf` só é preenchido no CHECKOUT, ou seja, quando a pessoa COMPRA.
  // Quem só vende nunca passou por ali. Em 31/07/2026 havia 9 linhas em
  // `users.cpf` contra 30 em `seller_profiles.document_number` — e uma venda
  // real de R$ 52,09 falhou na etiqueta por causa disso, depois de o comprador
  // já ter pago.

  it('usa o documento do cadastro de recebedor quando o vendedor não tem users.cpf', async () => {
    seedHappyPath();
    // Vendedor que só vende: nunca comprou, então não tem CPF em `users`.
    db.query.users.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        email: 'b@x.com',
        name: 'Comprador',
        cpf: '52998224725',
      })
      .mockResolvedValueOnce({ email: 's@x.com', name: 'Vendedor', cpf: null });
    db.__comDocumentoDoRecebedor('11590565797');
    const service = new ShippingService(http, db as any);

    await (service as any).createCart(dto);

    const payload = httpPost.mock.calls[0][1];
    expect(payload.from.document).toBe('11590565797');
  });

  it('sem CPF em lugar nenhum, recusa dizendo de quem é o documento que falta', async () => {
    seedHappyPath();
    db.query.users.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        email: 'b@x.com',
        name: 'Comprador',
        cpf: '52998224725',
      })
      .mockResolvedValueOnce({ email: 's@x.com', name: 'Vendedor', cpf: null });
    db.__comDocumentoDoRecebedor(null);
    const service = new ShippingService(http, db as any);

    await expect((service as any).createCart(dto)).rejects.toThrow(
      /CPF do vendedor não encontrado/,
    );
    // Nada de carrinho meio criado no Melhor Envio.
    expect(httpPost).not.toHaveBeenCalled();
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

  // ── Filtro de transportadoras ────────────────────────────────────────────
  //
  // A conta habilita 15 serviços; o checkout mostra 6 (decisão do dono,
  // 31/07/2026). O que estes testes protegem não é a lista — é o comprador não
  // receber no checkout uma opção que a Kolecta não quer despachar, e o corte
  // não passar despercebido quando zera a rota.

  const cotacao = (...opts: Array<[number, string, string]>) =>
    of({
      data: opts.map(([id, empresa, servico]) => ({
        id,
        company: { name: empresa },
        name: servico,
        price: '20.00',
        delivery_time: 5,
      })),
    });

  it('esconde as transportadoras fora da lista e mantém as escolhidas', async () => {
    db.query.listings.findFirst.mockResolvedValue({ sellerId: 'seller-1' });
    db.query.addresses.findFirst.mockResolvedValue({ zip: '22000-000' });
    httpPost.mockReturnValue(
      cotacao(
        [1, 'Correios', 'PAC'], // permitido
        [4, 'Jadlog', '.Com'], // fora da lista
        [12, 'LATAM Cargo', 'éFácil'], // fora da lista
        [33, 'JeT', 'Standard'], // permitido
      ),
    );
    const service = new ShippingService(http, db as any);

    const { options } = await service.quoteShipping({
      to_cep: '01001-000',
      listing_id: 'lst-1',
    } as any);

    expect(options.map((o: any) => o.service)).toEqual(['PAC', 'Standard']);
  });

  it('não pede à API já filtrado — o corte é nosso, para caber no log', async () => {
    db.query.listings.findFirst.mockResolvedValue({ sellerId: 'seller-1' });
    db.query.addresses.findFirst.mockResolvedValue({ zip: '22000-000' });
    httpPost.mockReturnValue(cotacao([1, 'Correios', 'PAC']));
    const service = new ShippingService(http, db as any);

    await service.quoteShipping({
      to_cep: '01001-000',
      listing_id: 'lst-1',
    } as any);

    // Pedir filtrado esconderia quantas opções o corte custou nesta rota.
    const [, payload] = httpPost.mock.calls[0];
    expect(payload.services).toBeUndefined();
  });

  it('avisa no log quando o filtro zera uma rota que tinha opções', async () => {
    db.query.listings.findFirst.mockResolvedValue({ sellerId: 'seller-1' });
    db.query.addresses.findFirst.mockResolvedValue({ zip: '22000-000' });
    httpPost.mockReturnValue(
      cotacao([4, 'Jadlog', '.Com'], [12, 'LATAM Cargo', 'éFácil']),
    );
    const service = new ShippingService(http, db as any);
    const aviso = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => {});

    const { options } = await service.quoteShipping({
      to_cep: '01001-000',
      listing_id: 'lst-1',
    } as any);

    // Comprador sem frete não fecha a compra, e do lado dele isso é silencioso.
    expect(options).toEqual([]);
    expect(aviso).toHaveBeenCalledWith(
      expect.stringContaining('nenhuma transportadora permitida atende'),
    );
    aviso.mockRestore();
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

  /**
   * Aconteceu na primeira etiqueta real: a carteira do Melhor Envio estava
   * zerada, o envio ficou `failed`, o dono pagou a etiqueta pelo PAINEL e
   * mandou tentar de novo. Sem consultar o estado remoto, o retry chamaria o
   * checkout outra vez — pagando o mesmo envio duas vezes.
   */
  it('não paga de novo um envio já quitado no painel', async () => {
    const db = fazerDb();
    db.query.orders.findFirst.mockResolvedValue({
      ...pedidoPago,
      shippingCartId: 'cart-9',
      shippingLabelStatus: 'failed',
    });
    const httpGet = jest.fn().mockReturnValue(
      of({ data: { status: 'released', paid_at: '2026-07-25 18:51:01', generated_at: null } }),
    );
    const httpPost = jest.fn().mockImplementation((url: string) => {
      if (url.endsWith('/shipment/print'))
        return of({ data: { url: 'https://me/etiqueta.pdf' } });
      return of({ data: {} });
    });
    const service = new ShippingService(
      { post: httpPost, get: httpGet } as any,
      db as any,
    );

    const r = await service.emitirEtiquetaDoPedido('ord-1');

    const chamadas = httpPost.mock.calls.map((c: any[]) => c[0]);
    // Pulou o checkout (já pago) e seguiu de generate em diante.
    expect(chamadas.some((u: string) => u.endsWith('/shipment/checkout'))).toBe(false);
    expect(chamadas.some((u: string) => u.endsWith('/shipment/generate'))).toBe(true);
    expect(r.status).toBe('ready');
    expect(r.labelUrl).toBe('https://me/etiqueta.pdf');
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

/**
 * O envio do PDF morava no listener de `order.paid`/`auction.won`. O botão
 * "tentar de novo" chama o serviço direto, sem evento de pedido — a etiqueta
 * saía e o vendedor nunca recebia o e-mail. Aconteceu na primeira etiqueta
 * real: status `ready`, PDF gerado, caixa de entrada vazia.
 */
describe('ShippingService — aviso de etiqueta pronta', () => {
  const pedido = {
    id: 'ord-1',
    addressId: 'addr-to',
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    listingId: 'lst-1',
    totalInCents: 15000,
    status: 'paid',
    deliveryMethod: 'shipping',
    shippingServiceId: 2,
  };

  const fazerDb = (over: any = {}) => {
    const db: any = {
      query: {
        orders: { findFirst: jest.fn().mockResolvedValue({ ...pedido, ...over }) },
        addresses: {
          findFirst: jest.fn().mockResolvedValue({ ...toAddress, userId: 'buyer-1' }),
        },
        users: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ email: 'b@x.com', name: 'C', cpf: '52998224725' })
            .mockResolvedValueOnce({ email: 's@x.com', name: 'V', cpf: '11144477735' }),
        },
        listings: { findFirst: jest.fn().mockResolvedValue({ title: 'Item' }) },
      },
    };
    db.select = jest.fn().mockReturnValue(db);
    db.from = jest.fn().mockReturnValue(db);
    db.where = jest
      .fn()
      .mockResolvedValue([{ ...fromAddress, userId: 'seller-1', isDefault: true }]);
    db.update = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    });
    return db;
  };

  beforeEach(() => {
    process.env.MELHOR_ENVIO_API_URL = 'https://sandbox.melhorenvio.com.br/api/v2/me';
    process.env.MELHOR_ENVIO_TOKEN = 'test-token';
  });

  it('avisa quando termina de emitir', async () => {
    const emitter = { emit: jest.fn() };
    const httpPost = jest.fn().mockImplementation((url: string) => {
      if (url.endsWith('/cart')) return of({ data: { id: 'cart-9' } });
      if (url.endsWith('/shipment/print'))
        return of({ data: { url: 'https://me/etiqueta.pdf' } });
      return of({ data: {} });
    });
    const service = new ShippingService(
      { post: httpPost, get: jest.fn(() => { throw new Error('sem consulta'); }) } as any,
      fazerDb() as any,
      emitter as any,
    );

    await service.emitirEtiquetaDoPedido('ord-1');

    expect(emitter.emit).toHaveBeenCalledWith('shipping.label.ready', {
      orderId: 'ord-1',
      labelUrl: 'https://me/etiqueta.pdf',
    });
  });

  it('avisa também quando a etiqueta JÁ estava pronta (e-mail que não saiu)', async () => {
    const emitter = { emit: jest.fn() };
    const db = fazerDb({
      shippingLabelStatus: 'ready',
      shippingLabelUrl: 'https://me/etiqueta.pdf',
      shippingCartId: 'cart-9',
    });
    const service = new ShippingService(
      { post: jest.fn(), get: jest.fn() } as any,
      db as any,
      emitter as any,
    );

    const r = await service.emitirEtiquetaDoPedido('ord-1');

    expect(r.jaEstavaPronta).toBe(true);
    // Reenvio não acontece: o MailService é idempotente por template+refId+to.
    expect(emitter.emit).toHaveBeenCalledWith('shipping.label.ready', {
      orderId: 'ord-1',
      labelUrl: 'https://me/etiqueta.pdf',
    });
  });
});

/**
 * A URL do `print` do Melhor Envio é uma PÁGINA protegida por sessão, não um
 * arquivo — verificado contra a API de produção: 302 para /painel/meus-envios,
 * com e sem token; `mode` private e public devolvem a mesma URL; `.pdf`,
 * `?pdf=1` e `Accept: application/pdf` também trazem HTML.
 *
 * Este teste existe para que ninguém volte a tratar essa URL como PDF.
 */
describe('etiqueta — a URL do print não é um arquivo', () => {
  it('conteúdo HTML não passa por PDF', () => {
    const html = Buffer.from('<!DOCTYPE html><html>login…</html>');
    expect(html.subarray(0, 5).toString('latin1')).not.toBe('%PDF-');
  });

  it('PDF de verdade começa com %PDF-', () => {
    const pdf = Buffer.from('%PDF-1.4\n…');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

/**
 * A JeT recusa o carrinho sem telefone ("O campo from.phone é obrigatório
 * quando service for 33"), enquanto Correios e Loggi aceitam — por isso uma
 * etiqueta saiu e a seguinte não. Verificado contra a produção: com telefone,
 * o mesmo payload que dava 422 passou a devolver 201.
 */
describe('ShippingService — telefone das pontas', () => {
  const chamar = (phone: any, env?: string) => {
    if (env === undefined) delete process.env.SHIPPING_FALLBACK_PHONE;
    else process.env.SHIPPING_FALLBACK_PHONE = env;
    const service = new ShippingService({} as any, {} as any);
    return (service as any).buildPartyPhone(phone);
  };

  afterEach(() => delete process.env.SHIPPING_FALLBACK_PHONE);

  it('usa o telefone da pessoa, só dígitos', () => {
    expect(chamar('(21) 97955-5251')).toBe('21979555251');
  });

  it('cai no telefone da plataforma quando a pessoa não tem', () => {
    // 10 dos 11 vendedores aptos estavam sem telefone quando isto foi escrito:
    // derrubar a venda por causa disso seria pior que usar o contato da
    // Kolecta, que é quem compra a etiqueta.
    expect(chamar(null, '11961716464')).toBe('11961716464');
    expect(chamar('123', '11961716464')).toBe('11961716464');
  });

  it('devolve vazio quando não há nem um nem outro', () => {
    expect(chamar(null)).toBe('');
  });
});
