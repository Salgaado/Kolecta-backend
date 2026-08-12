import { motivoPagarme } from './pagarme-erro';

/**
 * O erro que motivou o helper: a cobrança do arremate ia sem `billing_address`
 * e a Pagar.me recusava o request inteiro. O motivo estava no corpo, mas o
 * encadeamento antigo (`errors?.[0]?.message`) só lia a forma de LISTA e
 * escapava — a mensagem degradava para o `message` do nosso próprio embrulho,
 * "Erro na comunicação com a Pagar.me", que sugere falha de rede.
 */
const erroDeValidacao = (errors: Record<string, string | string[]>) => ({
  response: {
    message: 'Erro na comunicação com a Pagar.me', // embrulho do PagarmeService
    pagarme: { message: 'The request is invalid.', errors },
  },
});

describe('motivoPagarme', () => {
  describe('camada 1 — request recusado na validação (`errors` como objeto)', () => {
    it('devolve o CAMPO e o motivo, que é a informação acionável', () => {
      expect(
        motivoPagarme(erroDeValidacao({ billing: ['"value" is required'] })),
      ).toBe('billing: "value" is required');
    });

    it('junta todos os campos quando falta mais de um', () => {
      expect(
        motivoPagarme(
          erroDeValidacao({
            billing: ['"value" is required'],
            'customer.document': ['"document" is not allowed to be empty'],
          }),
        ),
      ).toBe(
        'billing: "value" is required; ' +
          'customer.document: "document" is not allowed to be empty',
      );
    });

    it('junta as várias mensagens de um mesmo campo', () => {
      expect(
        motivoPagarme(
          erroDeValidacao({ billing: ['obrigatório', 'inválido'] }),
        ),
      ).toBe('billing: obrigatório, inválido');
    });

    it('aceita o valor do campo como string solta, não só como lista', () => {
      expect(motivoPagarme(erroDeValidacao({ billing: 'obrigatório' }))).toBe(
        'billing: obrigatório',
      );
    });
  });

  describe('camada 1 — `errors` como lista', () => {
    it('junta as mensagens da lista', () => {
      const err = {
        response: {
          pagarme: { errors: [{ message: 'Recebedor inválido' }] },
        },
      };
      expect(motivoPagarme(err)).toBe('Recebedor inválido');
    });

    it('ignora entradas sem mensagem em vez de devolver vazio', () => {
      const err = {
        response: {
          pagarme: {
            message: 'The request is invalid.',
            errors: [{}, { message: 'Recebedor inválido' }],
          },
        },
      };
      expect(motivoPagarme(err)).toBe('Recebedor inválido');
    });

    it('cai no `message` do corpo quando a lista não tem nada aproveitável', () => {
      const err = {
        response: {
          pagarme: { message: 'The request is invalid.', errors: [] },
        },
      };
      expect(motivoPagarme(err)).toBe('The request is invalid.');
    });
  });

  describe('fallbacks', () => {
    it('usa o `message` da Pagar.me quando não há `errors`', () => {
      const err = { response: { pagarme: { message: 'Customer not found' } } };
      expect(motivoPagarme(err)).toBe('Customer not found');
    });

    /**
     * Sem corpo da Pagar.me (timeout, DNS, 502 de borda) a mensagem de
     * comunicação é a descrição CORRETA — o request não chegou a ser avaliado.
     */
    it('mantém a mensagem de comunicação quando não veio corpo nenhum', () => {
      const err = {
        response: {
          message: 'Erro na comunicação com a Pagar.me',
          pagarme: null,
        },
      };
      expect(motivoPagarme(err)).toBe('Erro na comunicação com a Pagar.me');
    });

    it('lê um Error comum, sem resposta HTTP', () => {
      expect(motivoPagarme(new Error('socket hang up'))).toBe('socket hang up');
    });

    it('devolve null quando não há o que dizer', () => {
      expect(motivoPagarme(undefined)).toBeNull();
      expect(motivoPagarme(null)).toBeNull();
      expect(motivoPagarme({})).toBeNull();
    });
  });
});
