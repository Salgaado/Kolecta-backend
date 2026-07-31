/**
 * Testa a simulação de parcelamento no cartão ("juros no comprador" pela tabela
 * de CET acordada com a Pagar.me). `simulateInstallments`/`computeInstallment`
 * são puros — não tocam as deps injetadas, então instanciamos o service com
 * nulls. A tabela de CET é baked-in no módulo (não depende de env), então o juro
 * aparece por padrão. `PAGARME_INSTALLMENT_INTEREST=off` zera (promoção).
 */

describe('OrdersService.simulateInstallments (tabela de CET)', () => {
  // Garante o comportamento padrão (juros ligado) antes do require do módulo.
  delete process.env.PAGARME_INSTALLMENT_INTEREST;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OrdersService } = require('./orders.service');
  const service = new OrdersService(null, null, null, null, null) as {
    simulateInstallments: (a: number) => any;
  };

  it('à vista (1x) nunca tem juros e o total == principal', () => {
    const { options } = service.simulateInstallments(50000);
    const first = options[0];
    expect(first.installments).toBe(1);
    expect(first.interestInCents).toBe(0);
    expect(first.totalInCents).toBe(50000);
    expect(first.hasInterest).toBe(false);
  });

  it('2x cobra o acréscimo CET_2 − CET_1x (6,44% − 3,89% = 2,55%)', () => {
    const { options } = service.simulateInstallments(50000);
    const em2 = options.find((o: any) => o.installments === 2);
    expect(em2).toBeDefined();
    expect(em2.hasInterest).toBe(true);
    // 50000 × 1,0255 = 51275 → parcela 25638 (×2 = 51276), juros 1276.
    expect(em2.installmentInCents).toBe(25638);
    expect(em2.totalInCents).toBe(51276);
    expect(em2.interestInCents).toBe(1276);
  });

  it('12x cobra o acréscimo CET_12 − CET_1x (21,24% − 3,89% = 17,35%)', () => {
    const { options } = service.simulateInstallments(50000);
    const em12 = options.find((o: any) => o.installments === 12);
    expect(em12).toBeDefined();
    // 50000 × 1,1735 = 58675 → parcela 4890 (×12 = 58680), juros 8680.
    expect(em12.installmentInCents).toBe(4890);
    expect(em12.totalInCents).toBe(58680);
    expect(em12.interestInCents).toBe(8680);
    // total == parcela × n (parcelas iguais, como a Pagar.me exibe)
    expect(em12.totalInCents).toBe(em12.installmentInCents * 12);
  });

  it('juros é monotonicamente crescente com o nº de parcelas', () => {
    const { options } = service.simulateInstallments(50000);
    for (let i = 1; i < options.length; i++) {
      expect(options[i].interestInCents).toBeGreaterThan(
        options[i - 1].interestInCents,
      );
    }
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

describe('OrdersService.simulateInstallments (PAGARME_INSTALLMENT_INTEREST=off)', () => {
  jest.isolateModules(() => {
    process.env.PAGARME_INSTALLMENT_INTEREST = 'off';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OrdersService } = require('./orders.service');
    const service = new OrdersService(null, null, null, null, null) as {
      simulateInstallments: (a: number) => any;
    };

    it('juros desligado → nenhuma parcela tem juro', () => {
      const { options } = service.simulateInstallments(50000);
      for (const o of options) {
        expect(o.interestInCents).toBe(0);
        expect(o.totalInCents).toBe(50000);
        expect(o.hasInterest).toBe(false);
      }
    });

    afterAll(() => {
      delete process.env.PAGARME_INSTALLMENT_INTEREST;
    });
  });
});
