/**
 * O cartão está fechado enquanto o antifraude da Pagar.me reprova todas as
 * cobranças — inclusive a pré-autorização do lance, que é 100% cartão.
 *
 * O que este teste protege é o PADRÃO: sem a variável, tem que ficar fechado.
 * O contrário (abrir por omissão) deixaria a plataforma aceitando cobrança que
 * o gateway recusa, travando anúncio e frustrando comprador e vendedor.
 */
describe('interruptor do cartão', () => {
  const carregar = () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./payment-flags');
  };

  afterEach(() => {
    delete process.env.PAGAMENTO_CARTAO_HABILITADO;
  });

  it('fica FECHADO quando a variável não existe', () => {
    delete process.env.PAGAMENTO_CARTAO_HABILITADO;
    expect(carregar().CARTAO_HABILITADO).toBe(false);
  });

  it('fica fechado com qualquer valor que não seja exatamente "true"', () => {
    for (const valor of ['1', 'sim', 'TRUE', 'yes', '']) {
      process.env.PAGAMENTO_CARTAO_HABILITADO = valor;
      expect(carregar().CARTAO_HABILITADO).toBe(false);
    }
  });

  it('só abre com "true" explícito', () => {
    process.env.PAGAMENTO_CARTAO_HABILITADO = 'true';
    expect(carregar().CARTAO_HABILITADO).toBe(true);
  });

  it('as mensagens dizem o que fazer agora e o que esperar', () => {
    const { CARTAO_INDISPONIVEL, LANCE_INDISPONIVEL } = carregar();
    // "Indisponível" sozinho não ajuda: o comprador precisa saber que o Pix
    // resolve hoje e que o cartão volta.
    expect(CARTAO_INDISPONIVEL).toMatch(/pix/i);
    expect(CARTAO_INDISPONIVEL).toMatch(/em breve/i);
    expect(LANCE_INDISPONIVEL).toMatch(/em breve/i);
  });
});
