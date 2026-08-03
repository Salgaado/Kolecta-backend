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
