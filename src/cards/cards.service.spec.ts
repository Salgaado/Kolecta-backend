/**
 * O cartão está FECHADO por padrão (`payment-flags.ts`) enquanto o antifraude
 * da Pagar.me reprova toda cobrança. Estes testes cobrem o cartão funcionando,
 * então ligam o interruptor antes do import — a flag é lida no carregamento do
 * módulo.
 */
process.env.PAGAMENTO_CARTAO_HABILITADO = 'true';

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { CardsService } from './cards.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { PagarmeService } from '../pagarme/pagarme.service';

/**
 * O foco aqui são os dados do TITULAR exigidos pela Pagar.me no `customer`:
 * documento e telefone. O lance cobra pelo `customer_id`, então não adianta
 * mandá-los inline na cobrança — precisam estar gravados no customer.
 *
 * Sobre o documento: O `customer` da Pagar.me nascia sem ele
 * quando o usuário não tinha CPF salvo, e a cobrança falhava só depois — no
 * lance, com uma mensagem que falava de cartão. Pior: o código forçava
 * `individual` e só aceitava 11 dígitos, então loja com CNPJ nunca passava.
 */
const mockPagarme = {
  post: jest.fn(),
  get: jest.fn(),
  put: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({}),
};

const makeDb = () => {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  // Padrão resolve vazio: as chamadas que este teste não encena (persistir o
  // customer, procurar cartão anterior) não podem quebrar a cadeia.
  chain.where = jest.fn().mockResolvedValue([]);
  chain.update = jest.fn().mockReturnValue(chain);
  chain.set = jest.fn().mockReturnValue(chain);
  chain.insert = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue([{ id: 'card_row' }]);
  chain.delete = jest.fn().mockReturnValue(chain);
  return chain;
};

const TELEFONE = '11988887777';

const usuario = (over: Record<string, unknown> = {}) => ({
  id: 'user_1',
  name: 'Loja Teste',
  email: 'loja@teste.com',
  cpf: null,
  phone: TELEFONE,
  pagarmeCustomerId: null,
  ...over,
});

describe('CardsService — dados do titular', () => {
  let db: any;
  let service: CardsService;

  const build = async () => {
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CardsService,
        { provide: DATABASE_CONNECTION, useValue: db },
        { provide: PagarmeService, useValue: mockPagarme },
      ],
    }).compile();
    return mod.get<CardsService>(CardsService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPagarme.post.mockReset();
    mockPagarme.get.mockReset();
    db = makeDb();
  });

  it('recusa com mensagem clara quando não há CPF nem CNPJ', async () => {
    db.where
      .mockResolvedValueOnce([usuario()]) // ensureCustomer → usuário
      .mockResolvedValueOnce([usuario()]) // resolveDocument → users.cpf
      .mockResolvedValueOnce([]); // resolveDocument → seller_profiles
    service = await build();

    await expect(service.saveCard('user_1', 'tok_1')).rejects.toThrow(
      BadRequestException,
    );
    // Não pode ter criado customer nenhum: o customer sem documento é
    // justamente o que quebrava a cobrança depois.
    expect(mockPagarme.post).not.toHaveBeenCalled();
  });

  it('usa CNPJ como company quando o vendedor é empresa', async () => {
    const CNPJ = '11222333000181';
    db.where
      .mockResolvedValueOnce([usuario()]) // ensureCustomer → usuário
      .mockResolvedValueOnce([usuario()]) // resolveDocument → users.cpf
      .mockResolvedValueOnce([{ doc: CNPJ }]) // resolveDocument → seller_profiles
      .mockResolvedValueOnce([usuario()]); // resolvePhone → users.phone
    mockPagarme.post
      .mockResolvedValueOnce({ id: 'cus_1' }) // /customers
      .mockResolvedValueOnce({
        id: 'card_1',
        brand: 'visa',
        last_four_digits: '1234',
        exp_month: 12,
        exp_year: 2030,
        holder_name: 'LOJA TESTE',
      });
    service = await build();

    await service.saveCard('user_1', 'tok_1');

    const corpo = mockPagarme.post.mock.calls[0][1];
    expect(corpo.type).toBe('company');
    expect(corpo.document).toBe(CNPJ);
    expect(corpo.document_type).toBe('CNPJ');
  });

  it('usa CPF como individual', async () => {
    const CPF = '52998224725';
    db.where
      .mockResolvedValueOnce([usuario({ cpf: CPF })]) // ensureCustomer
      .mockResolvedValueOnce([usuario({ cpf: CPF })]) // resolveDocument → users
      .mockResolvedValueOnce([]) // resolveDocument → seller_profiles
      .mockResolvedValueOnce([usuario({ cpf: CPF })]); // resolvePhone
    mockPagarme.post
      .mockResolvedValueOnce({ id: 'cus_1' })
      .mockResolvedValueOnce({
        id: 'card_1',
        brand: 'visa',
        last_four_digits: '1234',
        exp_month: 12,
        exp_year: 2030,
        holder_name: 'FULANO',
      });
    service = await build();

    await service.saveCard('user_1', 'tok_1');

    const corpo = mockPagarme.post.mock.calls[0][1];
    expect(corpo.type).toBe('individual');
    expect(corpo.document).toBe(CPF);
    expect(corpo.document_type).toBe('CPF');
  });

  it('manda o telefone do titular no customer', async () => {
    const CPF = '52998224725';
    db.where
      .mockResolvedValueOnce([usuario({ cpf: CPF })])
      .mockResolvedValueOnce([usuario({ cpf: CPF })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([usuario({ cpf: CPF })]);
    mockPagarme.post
      .mockResolvedValueOnce({ id: 'cus_1' })
      .mockResolvedValueOnce({
        id: 'card_1',
        brand: 'visa',
        last_four_digits: '1234',
        exp_month: 12,
        exp_year: 2030,
        holder_name: 'FULANO',
      });
    service = await build();

    await service.saveCard('user_1', 'tok_1');

    const corpo = mockPagarme.post.mock.calls[0][1];
    expect(corpo.phones.mobile_phone).toEqual({
      country_code: '55',
      area_code: '11',
      number: '988887777',
    });
  });

  /**
   * Este é o erro que travou o lance da Artminis: sem telefone a Pagar.me
   * recusa com "At least one customer phone is required" — uma mensagem que
   * não diz ao usuário o que fazer. Falhar aqui, antes de criar o customer,
   * evita o cartão "salvo" que nunca autoriza.
   */
  it('recusa com mensagem clara quando não há telefone', async () => {
    const CPF = '52998224725';
    db.where
      .mockResolvedValueOnce([usuario({ cpf: CPF, phone: null })])
      .mockResolvedValueOnce([usuario({ cpf: CPF, phone: null })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([usuario({ cpf: CPF, phone: null })]);
    service = await build();

    await expect(service.saveCard('user_1', 'tok_1')).rejects.toThrow(
      /telefone/i,
    );
    expect(mockPagarme.post).not.toHaveBeenCalled();
  });
});

/**
 * A troca de conta na Pagar.me (31/07) deixou `users.pagarme_customer_id`
 * apontando para customers que só existem na conta ANTIGA. O código lia o
 * customer, engolia o 404 e seguia mesmo assim — o `POST /customers/:id/cards`
 * então falhava, e o usuário levava um 400 opaco em toda tentativa, para
 * sempre. Sem caminho de saída: o id morto nunca era descartado.
 *
 * O mesmo vale para um `cus_...` de TESTE gravado no banco de produção.
 */
describe('CardsService — customer que não existe mais na conta', () => {
  let db: any;

  const CPF = '52998224725';
  const naoEncontrado = () =>
    Object.assign(new Error('Not Found'), { status: 404 });

  const build = async () => {
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CardsService,
        { provide: DATABASE_CONNECTION, useValue: db },
        { provide: PagarmeService, useValue: mockPagarme },
      ],
    }).compile();
    return mod.get<CardsService>(CardsService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPagarme.post.mockReset();
    mockPagarme.get.mockReset();
    db = makeDb();
  });

  it('descarta o id morto e cria um customer novo ao salvar o cartão', async () => {
    db.where
      .mockResolvedValueOnce([
        usuario({ cpf: CPF, pagarmeCustomerId: 'cus_da_conta_antiga' }),
      ]) // ensureCustomer → usuário
      .mockResolvedValueOnce([]) // descarte → delete saved_cards
      .mockResolvedValueOnce([]) // descarte → update users (limpa o customer)
      .mockResolvedValueOnce([usuario({ cpf: CPF })]) // resolveDocument → users
      .mockResolvedValueOnce([]) // resolveDocument → seller_profiles
      .mockResolvedValueOnce([usuario({ cpf: CPF })]); // resolvePhone
    mockPagarme.get.mockRejectedValueOnce(naoEncontrado());
    mockPagarme.post
      .mockResolvedValueOnce({ id: 'cus_novo' })
      .mockResolvedValueOnce({
        id: 'card_1',
        brand: 'visa',
        last_four_digits: '1234',
      });

    const service = await build();
    await service.saveCard('user_1', 'tok_1');

    // Criou um customer novo em vez de insistir no morto...
    expect(mockPagarme.post.mock.calls[0][0]).toBe('/customers');
    // ...e o cartão foi vinculado a ELE, não ao id antigo.
    expect(mockPagarme.post.mock.calls[1][0]).toBe('/customers/cus_novo/cards');
  });

  it('não devolve cartão para lance quando o customer sumiu', async () => {
    db.where
      .mockResolvedValueOnce([{ cardId: 'card_da_conta_antiga' }]) // saved_cards
      .mockResolvedValueOnce([{ customerId: 'cus_da_conta_antiga' }]); // users
    mockPagarme.get.mockRejectedValueOnce(naoEncontrado());

    const service = await build();

    // O cartão salvo estava vinculado ao customer que sumiu: devolver a dupla
    // só adiaria a falha para dentro da pré-autorização do lance.
    await expect(service.getCardRef('user_1')).resolves.toBeNull();
    expect(db.delete).toHaveBeenCalled();
  });

  it('erro que NÃO é 404 não destrói o cadastro (rede/5xx não provam nada)', async () => {
    db.where
      .mockResolvedValueOnce([{ cardId: 'card_1' }])
      .mockResolvedValueOnce([{ customerId: 'cus_1' }]);
    mockPagarme.get.mockRejectedValueOnce(
      Object.assign(new Error('Bad Gateway'), { status: 502 }),
    );

    const service = await build();

    await expect(service.getCardRef('user_1')).resolves.toEqual({
      customerId: 'cus_1',
      cardId: 'card_1',
    });
    expect(db.delete).not.toHaveBeenCalled();
  });
});

/**
 * A Pagar.me guarda a CÓPIA dela do nome e do e-mail. Corrigir o cadastro no
 * nosso banco não alcança essa cópia — e é ela que o antifraude lê.
 *
 * O caso (12/08): um comprador cujo customer nasceu "Novo Usuário" com e-mail
 * `<id>@placeholder.kolecta` tinha documento e telefone em ordem, então o
 * reparo saía na primeira linha e o cadastro nunca era atualizado. Ele pagou um
 * arremate e teve o outro barrado pelo antifraude.
 */
describe('CardsService — cadastro desatualizado na Pagar.me', () => {
  let db: any;

  const CPF = '52998224725';
  const PHONES_REMOTOS = {
    mobile_phone: { country_code: '55', area_code: '43', number: '991055311' },
  };

  /** Customer completo (documento + telefone) mas com os dados do placeholder. */
  const customerPlaceholder = () => ({
    document: CPF,
    name: 'Novo Usuário',
    email: 'user_1@placeholder.kolecta',
    phones: PHONES_REMOTOS,
  });

  const build = async () => {
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CardsService,
        { provide: DATABASE_CONNECTION, useValue: db },
        { provide: PagarmeService, useValue: mockPagarme },
      ],
    }).compile();
    return mod.get<CardsService>(CardsService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPagarme.post.mockReset();
    mockPagarme.get.mockReset();
    mockPagarme.put.mockReset().mockResolvedValue({});
    db = makeDb();
  });

  /** As leituras que o reparo faz depois de decidir que há o que consertar. */
  const encenarReparo = (over: {
    cpf?: string | null;
    phone?: string | null;
  }) =>
    db.where
      .mockResolvedValueOnce([usuario({ cpf: over.cpf ?? null })]) // resolveDocument → users
      .mockResolvedValueOnce([]) // resolveDocument → seller_profiles
      .mockResolvedValueOnce([usuario({ phone: over.phone ?? null })]); // resolvePhone

  it('ATUALIZA nome e e-mail quando o customer ficou com o placeholder', async () => {
    db.where
      .mockResolvedValueOnce([{ cardId: 'card_1' }])
      .mockResolvedValueOnce([{ customerId: 'cus_1' }])
      .mockResolvedValueOnce([
        { name: 'billy gois', email: 'fimdeobra@fimdeobra.com.br' },
      ]); // o nosso cadastro, já corrigido
    encenarReparo({ cpf: CPF, phone: TELEFONE });
    mockPagarme.get.mockResolvedValueOnce(customerPlaceholder());

    const service = await build();
    await service.getCardRef('user_1');

    expect(mockPagarme.put).toHaveBeenCalledWith(
      '/customers/cus_1',
      expect.objectContaining({
        name: 'billy gois',
        email: 'fimdeobra@fimdeobra.com.br',
      }),
    );
  });

  /**
   * O reparo roda em TODO lance e em todo pagamento de arremate. Se escrevesse
   * sempre, seria uma escrita na Pagar.me por lance.
   */
  it('NÃO escreve quando o cadastro remoto já está igual ao nosso', async () => {
    db.where
      .mockResolvedValueOnce([{ cardId: 'card_1' }])
      .mockResolvedValueOnce([{ customerId: 'cus_1' }])
      .mockResolvedValueOnce([
        { name: 'Billy Gois', email: 'fimdeobra@fimdeobra.com.br' },
      ]);
    mockPagarme.get.mockResolvedValueOnce({
      document: CPF,
      name: 'Billy Gois',
      email: 'fimdeobra@fimdeobra.com.br',
      phones: PHONES_REMOTOS,
    });

    const service = await build();
    await service.getCardRef('user_1');

    expect(mockPagarme.put).not.toHaveBeenCalled();
  });

  /**
   * A direção do reparo importa: se o placeholder estiver do NOSSO lado, mandar
   * ele para a Pagar.me trocaria um dado bom por um inútil.
   */
  it('NÃO empurra o placeholder do nosso lado por cima de um cadastro bom', async () => {
    db.where
      .mockResolvedValueOnce([{ cardId: 'card_1' }])
      .mockResolvedValueOnce([{ customerId: 'cus_1' }])
      .mockResolvedValueOnce([
        { name: 'Novo Usuário', email: 'user_1@placeholder.kolecta' },
      ]);
    mockPagarme.get.mockResolvedValueOnce({
      document: CPF,
      name: 'Billy Gois',
      email: 'fimdeobra@fimdeobra.com.br',
      phones: PHONES_REMOTOS,
    });

    const service = await build();
    await service.getCardRef('user_1');

    expect(mockPagarme.put).not.toHaveBeenCalled();
  });

  /**
   * O PUT da Pagar.me não é patch: campo omitido não é preservado. Consertar o
   * nome não pode apagar o telefone e quebrar a cobrança seguinte.
   */
  it('reenvia o telefone REMOTO quando não temos um telefone local', async () => {
    db.where
      .mockResolvedValueOnce([{ cardId: 'card_1' }])
      .mockResolvedValueOnce([{ customerId: 'cus_1' }])
      .mockResolvedValueOnce([
        { name: 'billy gois', email: 'fimdeobra@fimdeobra.com.br' },
      ]);
    encenarReparo({ cpf: CPF, phone: null }); // sem telefone no nosso banco
    mockPagarme.get.mockResolvedValueOnce(customerPlaceholder());

    const service = await build();
    await service.getCardRef('user_1');

    expect(mockPagarme.put).toHaveBeenCalledWith(
      '/customers/cus_1',
      expect.objectContaining({ phones: PHONES_REMOTOS }),
    );
  });

  /**
   * Reparo é best-effort. Exigir CPF de quem só tinha o nome desatualizado
   * trocaria um problema cosmético por um bloqueio — e o customer está
   * completo, então a cobrança funciona.
   */
  it('NÃO bloqueia o lance por falta de CPF local quando só o nome divergia', async () => {
    db.where
      .mockResolvedValueOnce([{ cardId: 'card_1' }])
      .mockResolvedValueOnce([{ customerId: 'cus_1' }])
      .mockResolvedValueOnce([
        { name: 'billy gois', email: 'fimdeobra@fimdeobra.com.br' },
      ]);
    encenarReparo({ cpf: null, phone: TELEFONE }); // sem documento nosso
    mockPagarme.get.mockResolvedValueOnce(customerPlaceholder());

    const service = await build();

    await expect(service.getCardRef('user_1')).resolves.toEqual({
      customerId: 'cus_1',
      cardId: 'card_1',
    });
    expect(mockPagarme.put).not.toHaveBeenCalled();
  });

  it('falha do PUT não derruba quem só queria dar um lance', async () => {
    db.where
      .mockResolvedValueOnce([{ cardId: 'card_1' }])
      .mockResolvedValueOnce([{ customerId: 'cus_1' }])
      .mockResolvedValueOnce([
        { name: 'billy gois', email: 'fimdeobra@fimdeobra.com.br' },
      ]);
    encenarReparo({ cpf: CPF, phone: TELEFONE });
    mockPagarme.get.mockResolvedValueOnce(customerPlaceholder());
    mockPagarme.put.mockRejectedValueOnce(new Error('502'));

    const service = await build();

    await expect(service.getCardRef('user_1')).resolves.toEqual({
      customerId: 'cus_1',
      cardId: 'card_1',
    });
  });
});
