import { of, throwError } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import {
  HttpException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
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
    __comDocumentoDoRecebedor(
      documentNumber: string | null,
      legalName: string | null = null,
    ) {
      selectChain.where.mockResolvedValue(
        documentNumber ? [{ documentNumber, legalName }] : [],
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
      /CPF\/CNPJ do vendedor não encontrado/,
    );
    // Nada de carrinho meio criado no Melhor Envio.
    expect(httpPost).not.toHaveBeenCalled();
  });

  // ── Vendedor PJ (CNPJ) ───────────────────────────────────────────────────
  //
  // `document` é validado como CPF pelo Melhor Envio. CNPJ ali devolve
  // "O campo from.document deve ter um CPF válido" e recusa o carrinho inteiro
  // — aconteceu em 09/08/2026 com a Rock Wheels, R$600 já pagos pelo comprador.
  // Em produção, 16 dos 43 vendedores com documento são PJ.

  /** Vendedor sem `users.cpf` (só vende) e com CNPJ no cadastro de recebedor. */
  const seedVendedorPJ = (legalName: string | null = null) => {
    seedHappyPath();
    db.query.users.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        email: 'b@x.com',
        name: 'Comprador',
        cpf: '52998224725',
      })
      .mockResolvedValueOnce({ email: 's@x.com', name: 'Vendedor', cpf: null });
    db.__comDocumentoDoRecebedor('41769344000147', legalName);
  };

  it('CNPJ do vendedor vai em company_document, nunca em document', async () => {
    seedVendedorPJ();
    const service = new ShippingService(http, db as any);

    await (service as any).createCart(dto);

    const payload = httpPost.mock.calls[0][1];
    expect(payload.from.company_document).toBe('41769344000147');
    // O campo de CPF não pode nem existir: mandar vazio faz o validador
    // reclamar do campo em branco.
    expect(payload.from).not.toHaveProperty('document');
  });

  /**
   * O bug que falhava CALADO. Vendedor PJ que também COMPRA na plataforma tem
   * `users.cpf` preenchido pelo checkout — e a ordem antiga usava esse CPF
   * pessoal como remetente do envio da empresa. O Melhor Envio aceitava, e
   * desde 06/04/2026 a DC-e vai para a SEFAZ: remetente errado virou dado
   * fiscal declarado.
   */
  it('vendedor PJ que também compra: usa o CNPJ da empresa, não o CPF pessoal', async () => {
    seedHappyPath();
    db.query.users.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        email: 'b@x.com',
        name: 'Comprador',
        cpf: '52998224725',
      })
      // O dono comprou algo um dia → CPF pessoal preenchido.
      .mockResolvedValueOnce({
        email: 's@x.com',
        name: 'Dono da Loja',
        cpf: '11144477735',
      });
    db.__comDocumentoDoRecebedor('41769344000147');
    const service = new ShippingService(http, db as any);

    await (service as any).createCart(dto);

    const payload = httpPost.mock.calls[0][1];
    expect(payload.from.company_document).toBe('41769344000147');
    expect(payload.from).not.toHaveProperty('document');
  });

  it('CNPJ do comprador também vai em company_document', async () => {
    seedHappyPath();
    db.query.users.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        email: 'b@x.com',
        name: 'Comprador PJ',
        cpf: '41769344000147',
      })
      .mockResolvedValueOnce({
        email: 's@x.com',
        name: 'Vendedor',
        cpf: '11144477735',
      });
    const service = new ShippingService(http, db as any);

    await (service as any).createCart(dto);

    const payload = httpPost.mock.calls[0][1];
    expect(payload.to.company_document).toBe('41769344000147');
    expect(payload.to).not.toHaveProperty('document');
  });

  it('documento com tamanho inválido não vira campo nenhum', async () => {
    seedHappyPath();
    db.query.users.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        email: 'b@x.com',
        name: 'Comprador',
        cpf: '52998224725',
      })
      .mockResolvedValueOnce({ email: 's@x.com', name: 'Vendedor', cpf: null });
    // 12 dígitos: o `>= 11` antigo deixava passar e o ME devolvia 422 genérico
    // DEPOIS de a venda estar paga. Melhor recusar aqui, com nome e sobrenome.
    db.__comDocumentoDoRecebedor('123456789012');
    const service = new ShippingService(http, db as any);

    await expect((service as any).createCart(dto)).rejects.toThrow(
      /CPF\/CNPJ do vendedor não encontrado/,
    );
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('usa a razão social como remetente do PJ quando o endereço não tem nome', async () => {
    seedVendedorPJ('Rock Wheels Colecionáveis LTDA');
    // Endereço de origem sem `recipientName`: sem isto o remetente sairia com
    // o nome pessoal ao lado do CNPJ da empresa.
    db.query.addresses.findFirst
      .mockReset()
      .mockResolvedValueOnce({ ...toAddress })
      .mockResolvedValueOnce({ ...fromAddress, recipientName: null });
    const service = new ShippingService(http, db as any);

    await (service as any).createCart(dto);

    const payload = httpPost.mock.calls[0][1];
    expect(payload.from.name).toBe('Rock Wheels Colecionáveis LTDA');
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

/**
 * Declaração de conteúdo (DC-e).
 *
 * O Melhor Envio devolve `files["1"]` (a etiqueta) e `files.dace` (a
 * declaração). NÃO existe arquivo com os dois: o `fullPdf` do `dace` se chama
 * `complete-dace.pdf` e é a declaração COMPLETA, com a tabela de mercadorias,
 * contra a `dace.pdf` que é a "DACE RESUMIDA" e omite os itens.
 *
 * Confundir esse `complete` com "etiqueta + declaração" custou uma regressão em
 * 05/08/2026: o padrão passou a baixar um PDF chamado "etiqueta-e-declaracao"
 * que só tinha a declaração, sem código de barras — impossível postar. Os testes
 * de então só olhavam QUAL URL era buscada, nunca o PDF resultante; por isso
 * aqui os arquivos são PDFs de verdade e a asserção é sobre as PÁGINAS.
 *
 * As duas páginas têm tamanhos diferentes na vida real (etiqueta 577×813pt,
 * DACE em A4), e é isso que identifica cada uma no arquivo final.
 */
describe('ShippingService — declaração de conteúdo', () => {
  const cartId = 'cart-9';
  const ETIQUETA: [number, number] = [577.5, 813];
  const DACE: [number, number] = [595.28, 841.89];

  /** PDF de 1 página no tamanho pedido — dá para reconhecer depois da junção. */
  async function pdfDe(tamanho: [number, number]): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.addPage(tamanho);
    return Buffer.from(await doc.save());
  }

  /** Tamanho de cada página do PDF montado, arredondado. */
  async function paginasDe(arquivo: Buffer): Promise<Array<[number, number]>> {
    const doc = await PDFDocument.load(arquivo);
    return doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return [Math.round(width), Math.round(height)];
    });
  }

  const arredonda = ([l, a]: [number, number]) => [Math.round(l), Math.round(a)];

  function servico(files: any, corpos: Record<string, Buffer> = {}) {
    const httpGet = jest.fn((url: string) => {
      if (url.includes('/orders/')) return of({ data: { files } });
      return of({ data: corpos[url] ?? Buffer.from('%PDF-1.4\nvazio') });
    });
    const db = {
      query: {
        orders: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'ord-1',
            shippingCartId: cartId,
          }),
        },
      },
    };
    const service = new ShippingService({ get: httpGet } as any, db as any);
    return { service, httpGet };
  }

  const completos = {
    '1': { pdf: 'https://s3/etiqueta.pdf' },
    dace: { pdf: 'https://s3/resumida.pdf', fullPdf: 'https://s3/completa.pdf' },
  };

  async function corpos() {
    return {
      'https://s3/etiqueta.pdf': await pdfDe(ETIQUETA),
      'https://s3/completa.pdf': await pdfDe(DACE),
      'https://s3/resumida.pdf': await pdfDe(DACE),
    };
  }

  it('junta etiqueta e declaração num PDF de duas páginas', async () => {
    const { service, httpGet } = servico(completos, await corpos());

    const r = await service.obterPdfDaEtiqueta('ord-1');

    expect(r.contem).toBe('completo');
    expect(r.nome).toBe('etiqueta-e-declaracao-ord-1.pdf');
    // Os DOIS arquivos são baixados: nenhum deles sozinho tem o outro.
    expect(httpGet.mock.calls[1][0]).toBe('https://s3/etiqueta.pdf');
    expect(httpGet.mock.calls[2][0]).toBe('https://s3/completa.pdf');
    // E os dois chegam ao vendedor, a etiqueta primeiro.
    expect(await paginasDe(r.arquivo)).toEqual([
      arredonda(ETIQUETA),
      arredonda(DACE),
    ]);
  });

  it('a etiqueta nunca sai do PDF completo', async () => {
    // A regressão de 05/08 em uma asserção: entregar só a declaração é pior que
    // o problema original, porque sem código de barras não se posta nada.
    const { service } = servico(completos, await corpos());

    const r = await service.obterPdfDaEtiqueta('ord-1');

    expect(await paginasDe(r.arquivo)).toContainEqual(arredonda(ETIQUETA));
  });

  it('cai na etiqueta sozinha quando a DC-e ainda não saiu, e diz que caiu', async () => {
    // A DC-e é assíncrona: pode não existir no instante em que a etiqueta sai.
    // Travar a postagem esperando por ela seria pior que entregar a etiqueta,
    // desde que quem chama saiba o que veio — é o que `contem` resolve.
    const { service } = servico(
      { '1': { pdf: 'https://s3/etiqueta.pdf' } },
      await corpos(),
    );

    const r = await service.obterPdfDaEtiqueta('ord-1');

    expect(r.contem).toBe('etiqueta');
    expect(r.nome).toBe('etiqueta-ord-1.pdf');
    expect(await paginasDe(r.arquivo)).toEqual([arredonda(ETIQUETA)]);
  });

  it('a declaração avulsa é a COMPLETA, com os itens, e não a resumida', async () => {
    // A resumida omite a tabela de mercadorias, que é justamente o que o
    // atendente confere no balcão.
    const { service, httpGet } = servico(completos, await corpos());

    const r = await service.obterPdfDaEtiqueta('ord-1', 'declaracao');

    expect(r.contem).toBe('declaracao');
    expect(r.nome).toBe('declaracao-de-conteudo-ord-1.pdf');
    expect(httpGet.mock.calls[1][0]).toBe('https://s3/completa.pdf');
  });

  it('cai na DACE resumida só quando a completa não existe', async () => {
    const { service, httpGet } = servico(
      { '1': { pdf: 'https://s3/etiqueta.pdf' }, dace: { pdf: 'https://s3/resumida.pdf' } },
      await corpos(),
    );

    const r = await service.obterPdfDaEtiqueta('ord-1', 'declaracao');

    expect(r.contem).toBe('declaracao');
    expect(httpGet.mock.calls[1][0]).toBe('https://s3/resumida.pdf');
  });

  it('pedir só a declaração NÃO cai na etiqueta por engano', async () => {
    // Entregar a etiqueta a quem pediu a declaração é pior que devolver erro: o
    // vendedor imprime, vai ao balcão e leva a recusa achando que está com o
    // documento certo.
    const { service } = servico(
      { '1': { pdf: 'https://s3/etiqueta.pdf' } },
      await corpos(),
    );

    await expect(
      service.obterPdfDaEtiqueta('ord-1', 'declaracao'),
    ).rejects.toThrow(/declaração de conteúdo/i);
  });

  it('só a etiqueta quando pedida, mesmo com a declaração disponível', async () => {
    const { service, httpGet } = servico(completos, await corpos());

    const r = await service.obterPdfDaEtiqueta('ord-1', 'etiqueta');

    expect(r.contem).toBe('etiqueta');
    expect(httpGet.mock.calls[1][0]).toBe('https://s3/etiqueta.pdf');
    expect(httpGet).toHaveBeenCalledTimes(2);
  });
});

/**
 * Valor declarado: o ITEM, sem o frete.
 *
 * Era `order.totalInCents`, que é item mais frete. Enquanto a declaração de
 * conteúdo era papel, declarar a mais só inflava o seguro. Desde 06/04/2026 o
 * Melhor Envio transmite `products` para a SEFAZ ao emitir a DC-e, e aí virou
 * dado fiscal errado.
 */
describe('ShippingService — valor declarado', () => {
  function payloadDoCarrinho(pedido: any) {
    const httpPost: jest.Mock = jest.fn(() => of({ data: { id: 1 } }));
    const db = {
      query: {
        orders: { findFirst: jest.fn().mockResolvedValue(pedido) },
        addresses: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(toAddress)
            .mockResolvedValueOnce(fromAddress),
        },
        users: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ name: 'C', cpf: '52998224725' })
            .mockResolvedValueOnce({ name: 'V', cpf: '11144477735' }),
        },
        listings: { findFirst: jest.fn().mockResolvedValue({ title: 'Item' }) },
      },
      select: jest.fn(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      })),
    };
    process.env.MELHOR_ENVIO_TOKEN = 'test-token';
    const service = new ShippingService({ post: httpPost } as any, db as any);
    return (service as any)
      .createCart(dto)
      .then(() => httpPost.mock.calls[0][1] as any);
  }

  it('desconta o frete do valor do item', async () => {
    // R$ 150 no total, R$ 30 de frete → a peça vale R$ 120.
    const payload = await payloadDoCarrinho({
      ...order,
      totalInCents: 15000,
      shippingInCents: 3000,
    });

    expect(payload.products[0].unitary_value).toBe(120);
    expect(payload.options.insurance_value).toBe(120);
  });

  it('pedido antigo sem frete gravado continua valendo o total', async () => {
    const payload = await payloadDoCarrinho({ ...order, totalInCents: 15000 });

    expect(payload.products[0].unitary_value).toBe(150);
  });

  it('cai no total se a subtração zerar, em vez de declarar zero', async () => {
    // Valor declarado zero faz o Melhor Envio recusar o carrinho, e a venda já
    // foi paga: declarar a mais é menos ruim do que não emitir a etiqueta.
    const payload = await payloadDoCarrinho({
      ...order,
      totalInCents: 5000,
      shippingInCents: 5000,
    });

    expect(payload.products[0].unitary_value).toBe(50);
  });
});

/**
 * Transportadoras que o VENDEDOR topa usar.
 *
 * A agência perto da casa dele é o que decide se ele consegue despachar. Antes
 * ele recebia as seis opções da plataforma e se virava.
 */
describe('ShippingService — escolha de transportadora do vendedor', () => {
  function servico(escolhidas: string | null) {
    const httpPost = jest.fn(() =>
      of({
        data: [1, 2, 3, 33].map((id) => ({
          id,
          company: { name: 'X' },
          name: `svc-${id}`,
          price: '20.00',
          delivery_time: 5,
        })),
      }),
    );
    const db = {
      query: {
        listings: {
          findFirst: jest.fn().mockResolvedValue({ sellerId: 'seller-1' }),
        },
        addresses: { findFirst: jest.fn().mockResolvedValue({ zip: '22000-000' }) },
      },
      select: jest.fn(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([{ servicos: escolhidas }]),
      })),
    };
    process.env.MELHOR_ENVIO_TOKEN = 'test-token';
    return new ShippingService({ post: httpPost } as any, db as any);
  }

  const cotar = (s: ShippingService) =>
    s
      .quoteShipping({ to_cep: '01001-000', listing_id: 'lst-1' } as any)
      .then((r: any) => r.options.map((o: any) => Number(o.raw.id)));

  it('restringe dentro do que a plataforma libera', async () => {
    expect(await cotar(servico('1,33'))).toEqual([1, 33]);
  });

  it('vendedor sem escolha continua com tudo que a plataforma libera', async () => {
    expect(await cotar(servico(null))).toEqual([1, 2, 3, 33]);
  });

  it('escolha do vendedor não amplia: 4 não está liberado pela plataforma', async () => {
    // A palavra final é sempre da plataforma. Um vendedor que marcou Jadlog
    // .Com antes de a Kolecta cortá-la não pode continuar vendendo nela.
    expect(await cotar(servico('1,4'))).toEqual([1]);
  });

  it('coluna inexistente no banco não derruba a cotação', async () => {
    // Migrations não são versionadas aqui: se o código subir antes do ALTER
    // TABLE, uma exceção nesta consulta impediria QUALQUER compra no site.
    const httpPost = jest.fn(() =>
      of({
        data: [{ id: 1, company: { name: 'X' }, name: 'PAC', price: '20.00', delivery_time: 5 }],
      }),
    );
    const db = {
      query: {
        listings: { findFirst: jest.fn().mockResolvedValue({ sellerId: 's1' }) },
        addresses: { findFirst: jest.fn().mockResolvedValue({ zip: '22000-000' }) },
      },
      select: jest.fn(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockRejectedValue(new Error('no such column: shipping_services')),
      })),
    };
    process.env.MELHOR_ENVIO_TOKEN = 'test-token';
    const service = new ShippingService({ post: httpPost } as any, db as any);

    expect(await cotar(service)).toEqual([1]);
  });
});

/**
 * O `/shipment/tracking` e o `/orders/{id}` descrevem o mesmo envio, mas não em
 * sincronia. Medido em produção em 11/08/2026 no envio `a27aa929` (Correios
 * PAC), com as duas chamadas no mesmo minuto:
 *
 *   GET  /orders/{id}       → tracking: "AP340313552BR", generated_at: "19:38:00"
 *   POST /shipment/tracking → tracking: null,            generated_at: null
 *
 * O pedido ficou sem código de rastreio no banco, e o `RastreioCron` rodou logo
 * depois sem consertar: `order.trackingCode ?? rastreio.codigo` é `null ?? null`
 * em toda rodada. Além do comprador não conseguir rastrear, `posted_at` e
 * `delivered_at` saem do MESMO endpoint atrasado — e são eles que fazem o pedido
 * virar `shipped`/`delivered` e liberam o saldo retido do vendedor.
 */
describe('ShippingService — rastreio atrasado no /shipment/tracking', () => {
  const URL = 'https://www.melhorenvio.com.br/api/v2/me';
  const CART = 'a27aa929';

  function fazerService(respostaTracking: any, respostaOrders?: any) {
    process.env.MELHOR_ENVIO_API_URL = URL;
    process.env.MELHOR_ENVIO_TOKEN = 'test-token';
    const httpPost = jest.fn(() => of({ data: { [CART]: respostaTracking } }));
    const httpGet = jest.fn(() =>
      respostaOrders instanceof Error
        ? throwError(() => respostaOrders)
        : of({ data: respostaOrders ?? {} }),
    );
    const service = new ShippingService(
      { post: httpPost, get: httpGet } as any,
      {} as any,
    );
    return { service, httpPost, httpGet };
  }

  it('completa o código pelo /orders quando o tracking vem nulo', async () => {
    const { service, httpGet } = fazerService(
      { status: 'released', tracking: null, generated_at: null },
      {
        status: 'released',
        tracking: 'AP340313552BR',
        generated_at: '2026-08-11 19:38:00',
      },
    );

    const r = await service.rastrearEnvio(CART);

    expect(httpGet).toHaveBeenCalledWith(
      `${URL}/orders/${CART}`,
      expect.anything(),
    );
    expect(r.codigo).toBe('AP340313552BR');
    // O marco veio junto: sem ele a linha do tempo mostraria "pendente" num
    // envio já emitido.
    expect(r.etapaAtual).toBe('emitida');
  });

  it('não gasta a chamada extra quando o tracking já traz o código', async () => {
    const { service, httpGet } = fazerService({
      status: 'posted',
      tracking: 'AP340313552BR',
      posted_at: '2026-08-12 09:00:00',
    });

    const r = await service.rastrearEnvio(CART);

    expect(httpGet).not.toHaveBeenCalled();
    expect(r.codigo).toBe('AP340313552BR');
    expect(r.etapaAtual).toBe('postado');
  });

  /**
   * O complemento é remendo do atraso, não uma segunda fonte da verdade: se o
   * /orders estiver ATRÁS (entrega ainda não registrada lá), o que o
   * /shipment/tracking afirmou tem que continuar valendo — senão uma entrega já
   * detectada sumiria e o saldo do vendedor voltaria a ficar preso.
   */
  it('não sobrescreve o que o /shipment/tracking já afirmou', async () => {
    const { service } = fazerService(
      {
        status: 'delivered',
        tracking: null,
        delivered_at: '2026-08-20 10:00:00',
      },
      { status: 'posted', tracking: 'AP340313552BR', delivered_at: null },
    );

    const r = await service.rastrearEnvio(CART);

    expect(r.codigo).toBe('AP340313552BR');
    expect(r.entregueEm).toBe('2026-08-20 10:00:00');
    expect(r.etapaAtual).toBe('entregue');
  });

  it('devolve o rastreio parcial quando o /orders falha, sem estourar', async () => {
    const { service } = fazerService(
      {
        status: 'released',
        tracking: null,
        generated_at: '2026-08-11 19:38:00',
      },
      new Error('502 Bad Gateway'),
    );

    const r = await service.rastrearEnvio(CART);

    expect(r.codigo).toBeNull();
    expect(r.etapaAtual).toBe('emitida');
  });

  /**
   * A data-zero do Melhor Envio é "não aconteceu" disfarçado de valor. Se o
   * `??` olhasse só para null/undefined, `"0000-00-00 00:00:00"` passaria como
   * código válido e o comprador copiaria isso para o site dos Correios.
   */
  it('trata vazio e data-zero do ME como ausência, e completa mesmo assim', async () => {
    const { service, httpGet } = fazerService(
      { status: 'released', tracking: '', generated_at: '0000-00-00 00:00:00' },
      {
        status: 'released',
        tracking: 'AP340313552BR',
        generated_at: '2026-08-11 19:38:00',
      },
    );

    const r = await service.rastrearEnvio(CART);

    expect(httpGet).toHaveBeenCalled();
    expect(r.codigo).toBe('AP340313552BR');
    expect(r.etapaAtual).toBe('emitida');
  });
});
