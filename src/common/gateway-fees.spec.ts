/**
 * A taxa do gateway é ESPELHO, não cobrança: quem desconta é a Pagar.me, via
 * `charge_processing_fee` no recebedor do vendedor. O que este cálculo decide é
 * quanto a carteira interna retém — e espelho errado não devolve dinheiro a
 * ninguém, só faz o vendedor ver saldo que não existe no recebedor dele e
 * tentar sacar um valor que a transferência vai recusar.
 *
 * Até 31/07/2026 o leilão gravava `gatewayFeeInCents: 0` fixo enquanto a compra
 * lia as env — o mesmo arremate valia dois números conforme o caminho. Estes
 * testes existem para que a fonte volte a ser uma só.
 */
describe('taxa do gateway (espelho da carteira)', () => {
  const carregar = () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./gateway-fees');
  };

  afterEach(() => {
    delete process.env.PAGARME_CARD_FEE_PERCENT;
    delete process.env.PAGARME_GATEWAY_FEE_PERCENT;
  });

  it('sem as variáveis, não desconta nada', () => {
    delete process.env.PAGARME_CARD_FEE_PERCENT;
    delete process.env.PAGARME_GATEWAY_FEE_PERCENT;
    const { calcGatewayFeeInCents } = carregar();
    expect(calcGatewayFeeInCents(10000, 'credit_card')).toBe(0);
    expect(calcGatewayFeeInCents(10000, 'pix')).toBe(0);
  });

  it('usa a taxa do CARTÃO no cartão e a do PIX no resto', () => {
    process.env.PAGARME_CARD_FEE_PERCENT = '3.89';
    process.env.PAGARME_GATEWAY_FEE_PERCENT = '1.09';
    const { calcGatewayFeeInCents } = carregar();
    // Contrato da conta nova: MDR 3,89% no crédito à vista, 1,09% no PIX.
    expect(calcGatewayFeeInCents(10000, 'credit_card')).toBe(389);
    expect(calcGatewayFeeInCents(10000, 'pix')).toBe(109);
  });

  it('instrumento ausente cai na taxa do PIX, não na do cartão', () => {
    process.env.PAGARME_CARD_FEE_PERCENT = '3.89';
    process.env.PAGARME_GATEWAY_FEE_PERCENT = '1.09';
    const { calcGatewayFeeInCents } = carregar();
    // Errar para o lado barato deixa o vendedor com saldo levemente maior;
    // errar para o caro cobraria dele uma taxa de cartão que não houve.
    expect(calcGatewayFeeInCents(10000, null)).toBe(109);
    expect(calcGatewayFeeInCents(10000, undefined)).toBe(109);
  });

  it('arredonda para o centavo mais próximo', () => {
    process.env.PAGARME_CARD_FEE_PERCENT = '3.89';
    const { calcGatewayFeeInCents } = carregar();
    // 3333 × 3,89% = 129,65 centavos → 130.
    expect(calcGatewayFeeInCents(3333, 'credit_card')).toBe(130);
    expect(Number.isInteger(calcGatewayFeeInCents(7777, 'credit_card'))).toBe(
      true,
    );
  });

  it('valor zero não gera taxa (pedido 100% pago com saldo da wallet)', () => {
    process.env.PAGARME_CARD_FEE_PERCENT = '3.89';
    const { calcGatewayFeeInCents } = carregar();
    expect(calcGatewayFeeInCents(0, 'credit_card')).toBe(0);
  });
});
