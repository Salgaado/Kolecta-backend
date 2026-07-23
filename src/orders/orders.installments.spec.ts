/**
 * Testa a simulação de parcelamento no cartão (tabela Price, "juros no comprador").
 * `simulateInstallments`/`computeInstallment` são puros — não tocam as deps
 * injetadas, então instanciamos o service com nulls. O juro é lido de env no
 * carregamento do módulo; este arquivo tem registry próprio no Jest, então
 * setamos a env ANTES do require para exercitar o caminho com juros.
 */

describe('OrdersService.simulateInstallments (com juros)', () => {
  // 2,99% a.m. — precisa vir antes do require do módulo.
  process.env.PAGARME_CARD_INTEREST_PERCENT = '2.99';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OrdersService } = require('./orders.service');
  const service = new OrdersService(
    null,
    null,
    null,
    null,
    null,
  ) as { simulateInstallments: (a: number) => any };

  it('à vista (1x) nunca tem juros e o total == principal', () => {
    const { options } = service.simulateInstallments(50000);
    const first = options[0];
    expect(first.installments).toBe(1);
    expect(first.interestInCents).toBe(0);
    expect(first.totalInCents).toBe(50000);
    expect(first.hasInterest).toBe(false);
  });

  it('parcelado embute juros crescente e o total > principal', () => {
    const { options } = service.simulateInstallments(50000);
    const em12 = options.find((o: any) => o.installments === 12);
    expect(em12).toBeDefined();
    expect(em12.interestInCents).toBeGreaterThan(0);
    expect(em12.totalInCents).toBeGreaterThan(50000);
    // total == parcela × n (parcelas iguais, como a Pagar.me exibe)
    expect(em12.totalInCents).toBe(em12.installmentInCents * 12);
  });

  it('limita a 12x', () => {
    const { options } = service.simulateInstallments(500000);
    expect(options[options.length - 1].installments).toBe(12);
  });

  it('respeita a parcela mínima (R$5): R$30 → no máx 6x', () => {
    const { options } = service.simulateInstallments(3000);
    expect(options[options.length - 1].installments).toBe(6);
  });

  it('rejeita valor inválido', () => {
    expect(() => service.simulateInstallments(0)).toThrow();
  });
});

describe('OrdersService.simulateInstallments (sem juros — env ausente)', () => {
  jest.isolateModules(() => {
    delete process.env.PAGARME_CARD_INTEREST_PERCENT;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OrdersService } = require('./orders.service');
    const service = new OrdersService(null, null, null, null, null) as {
      simulateInstallments: (a: number) => any;
    };

    it('sem juros configurado, nenhuma parcela tem juro', () => {
      const { options } = service.simulateInstallments(50000);
      for (const o of options) {
        expect(o.interestInCents).toBe(0);
        expect(o.totalInCents).toBe(50000);
      }
    });
  });
});
