import {
  comissaoEmCentavos,
  freteCheioEmCentavos,
  freteEmCentavos,
  receitaLiquidaEmCentavos,
} from './comissao';

describe('comissao', () => {
  describe('pedido NOVO (frete embutido no platform_fee)', () => {
    // Item R$ 100, frete R$ 15,50, comissão 11% → fee = 11,00 + 15,50.
    const pedido = { platformFeeInCents: 2_650, shippingInCents: 1_550 };

    it('separa a comissão do frete', () => {
      expect(comissaoEmCentavos(pedido)).toBe(1_100);
      expect(freteEmCentavos(pedido)).toBe(1_550);
    });
  });

  describe('pedido ANTIGO (frete ia para o vendedor)', () => {
    // fee = só comissão, e o frete costumava superá-la.
    const pedido = { platformFeeInCents: 440, shippingInCents: 1_300 };

    it('devolve a taxa inteira, sem subtrair frete que não está lá', () => {
      expect(comissaoEmCentavos(pedido)).toBe(440);
      expect(freteEmCentavos(pedido)).toBe(0);
    });
  });

  describe('retirada em mãos', () => {
    const pedido = { platformFeeInCents: 1_100, shippingInCents: 0 };

    it('sem frete, a taxa é a comissão', () => {
      expect(comissaoEmCentavos(pedido)).toBe(1_100);
      expect(freteEmCentavos(pedido)).toBe(0);
    });
  });

  describe('receitaLiquidaEmCentavos — frete compartilhado', () => {
    it('desconta o subsídio da comissão bruta', () => {
      // Ticket médio real: item R$ 165,23, frete cheio R$ 13,76, subsídio
      // R$ 11,57. O comprador paga R$ 2,19 de frete; a Kolecta fica com
      // comissão R$ 18,18 − R$ 11,57 = R$ 6,61.
      const pedido = {
        platformFeeInCents: 1_818 + 219,
        shippingInCents: 219,
        shippingCostInCents: 1_376,
        shippingSubsidyInCents: 1_157,
      };

      expect(comissaoEmCentavos(pedido)).toBe(1_818);
      expect(receitaLiquidaEmCentavos(pedido)).toBe(661);
    });

    it('take líquido de 4% no ticket médio — o piso da política', () => {
      const item = 16_523;
      const pedido = {
        platformFeeInCents: Math.round(item * 0.11) + 219,
        shippingInCents: 219,
        shippingCostInCents: 1_376,
        shippingSubsidyInCents: 1_157,
      };
      expect(receitaLiquidaEmCentavos(pedido) / item).toBeCloseTo(0.04, 3);
    });

    it('frete grátis (subsídio == frete cheio): comprador não paga frete', () => {
      // Item R$ 300, frete R$ 13,76 coberto inteiro.
      const pedido = {
        platformFeeInCents: 3_300,
        shippingInCents: 0,
        shippingCostInCents: 1_376,
        shippingSubsidyInCents: 1_376,
      };
      expect(comissaoEmCentavos(pedido)).toBe(3_300);
      expect(receitaLiquidaEmCentavos(pedido)).toBe(1_924);
    });

    it('pedido sem subsídio: receita líquida == comissão', () => {
      const pedido = {
        platformFeeInCents: 2_650,
        shippingInCents: 1_550,
        shippingCostInCents: 1_550,
        shippingSubsidyInCents: 0,
      };
      expect(receitaLiquidaEmCentavos(pedido)).toBe(comissaoEmCentavos(pedido));
    });

    it('pedido ANTERIOR à política (colunas nulas): as duas coincidem', () => {
      const pedido = { platformFeeInCents: 2_650, shippingInCents: 1_550 };
      expect(receitaLiquidaEmCentavos(pedido)).toBe(comissaoEmCentavos(pedido));
    });
  });

  describe('freteCheioEmCentavos', () => {
    it('devolve o custo real da etiqueta quando ele existe', () => {
      expect(
        freteCheioEmCentavos({
          shippingInCents: 219,
          shippingCostInCents: 1_376,
        }),
      ).toBe(1_376);
    });

    it('cai no frete cobrado em pedido anterior à política', () => {
      expect(freteCheioEmCentavos({ shippingInCents: 1_550 })).toBe(1_550);
    });

    it('zero quando não há frete nenhum', () => {
      expect(freteCheioEmCentavos({})).toBe(0);
    });

    it('nunca é menor que o frete cobrado (invariante da coluna)', () => {
      for (let cost = 0; cost <= 5_000; cost += 137) {
        for (let subsidy = 0; subsidy <= cost; subsidy += 211) {
          const pedido = {
            shippingInCents: cost - subsidy,
            shippingCostInCents: cost,
          };
          expect(freteCheioEmCentavos(pedido)).toBeGreaterThanOrEqual(
            pedido.shippingInCents,
          );
        }
      }
    });
  });
});
