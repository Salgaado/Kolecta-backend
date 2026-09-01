import {
  POLITICA_DESLIGADA,
  PoliticaSubsidio,
  politicaDoAmbiente,
  subsidioEmCentavos,
  subsidioMaximoEmCentavos,
} from './frete-subsidio';

/** A política como ela vai ao ar: 7% do item, teto R$ 30, piso R$ 100. */
const LIGADA: PoliticaSubsidio = {
  ativo: true,
  percentualDoItem: 7,
  tetoEmCentavos: 3000,
  pisoDoItemEmCentavos: 10000,
};

const reais = (centavos: number) => centavos / 100;

describe('frete-subsidio', () => {
  describe('política desligada', () => {
    it('não subsidia nada, em nenhuma combinação', () => {
      for (let item = 0; item <= 200_000; item += 1_000) {
        for (let frete = 0; frete <= 5_000; frete += 250) {
          expect(subsidioEmCentavos(item, frete, POLITICA_DESLIGADA)).toBe(0);
        }
      }
    });

    it('zera também o número do selo', () => {
      expect(subsidioMaximoEmCentavos(50_000, POLITICA_DESLIGADA)).toBe(0);
    });
  });

  describe('elegibilidade (piso de R$ 100)', () => {
    it('item abaixo do piso não recebe nada, por mais barato que seja o frete', () => {
      for (let item = 0; item < 10_000; item += 100) {
        expect(subsidioEmCentavos(item, 1_300, LIGADA)).toBe(0);
      }
    });

    it('R$ 99,99 não recebe e R$ 100,00 recebe', () => {
      expect(subsidioEmCentavos(9_999, 1_376, LIGADA)).toBe(0);
      expect(subsidioEmCentavos(10_000, 1_376, LIGADA)).toBe(700);
    });
  });

  describe('frete barato: a Kolecta cobre 100%', () => {
    it('F ≤ 7%×P → S = F, e o comprador paga exatamente o item', () => {
      // Item R$ 300, frete R$ 13,76. 7% de 300 = R$ 21 > R$ 13,76.
      const item = 30_000;
      const frete = 1_376;
      const s = subsidioEmCentavos(item, frete, LIGADA);
      expect(s).toBe(frete);
      expect(item + frete - s).toBe(item);
    });

    it('o limiar do frete grátis com frete R$ 13,76 fica em ~R$ 197', () => {
      const frete = 1_376;
      // R$ 196 ainda não cobre; R$ 197 cobre (7% de 19.700 = 1.379 ≥ 1.376).
      expect(subsidioEmCentavos(19_600, frete, LIGADA)).toBeLessThan(frete);
      expect(subsidioEmCentavos(19_700, frete, LIGADA)).toBe(frete);
    });
  });

  describe('frete caro: trava em 7% do item', () => {
    it('F > 7%×P → S = 7%×P', () => {
      // Item R$ 120, frete R$ 25. 7% de 120 = R$ 8,40.
      expect(subsidioEmCentavos(12_000, 2_500, LIGADA)).toBe(840);
    });

    it('o take líquido resultante é EXATAMENTE 4% (a propriedade estrutural)', () => {
      const COMISSAO = 0.11;
      for (let item = 10_000; item <= 200_000; item += 1_000) {
        // Frete caro o bastante para estourar os 7% em qualquer preço.
        const frete = Math.ceil(item * 0.07) + 1;
        const s = subsidioEmCentavos(item, frete, LIGADA);
        if (s >= LIGADA.tetoEmCentavos) continue; // faixa do teto, testada abaixo
        const liquido = item * COMISSAO - s;
        expect(liquido / item).toBeCloseTo(0.04, 4);
      }
    });
  });

  describe('teto de R$ 30', () => {
    it('7%×P acima do teto → S = R$ 30', () => {
      // Item R$ 500 → 7% = R$ 35, acima do teto.
      expect(subsidioEmCentavos(50_000, 5_000, LIGADA)).toBe(3_000);
      expect(subsidioMaximoEmCentavos(50_000, LIGADA)).toBe(3_000);
    });

    it('o teto começa a morder em R$ 428,58 de item', () => {
      // 7% de 42.857 = 2.999,99 → 3.000 arredondado. O ponto exato importa
      // pouco; o que importa é que abaixo dele o teto não morde.
      expect(subsidioMaximoEmCentavos(40_000, LIGADA)).toBe(2_800);
      expect(subsidioMaximoEmCentavos(60_000, LIGADA)).toBe(3_000);
    });
  });

  describe('a âncora é o frete mais barato', () => {
    it('escolher transportadora cara não aumenta o subsídio', () => {
      const item = 30_000;
      const maisBarato = 1_376; // PAC
      const s = subsidioEmCentavos(item, maisBarato, LIGADA);
      // Mesmo que o comprador pague SEDEX a R$ 45, a Kolecta banca R$ 13,76.
      expect(s).toBe(1_376);
      const sedex = 4_500;
      expect(sedex - s).toBe(3_124); // a diferença inteira é do comprador
    });
  });

  describe('invariantes, varridas', () => {
    it('0 ≤ S ≤ F, o comprador nunca paga mais que P+F, e o take nunca fura 4%', () => {
      const COMISSAO = 0.11;
      for (let item = 0; item <= 300_000; item += 2_500) {
        for (let frete = 0; frete <= 8_000; frete += 137) {
          const s = subsidioEmCentavos(item, frete, LIGADA);

          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(frete);
          expect(s).toBeLessThanOrEqual(LIGADA.tetoEmCentavos);
          expect(Number.isInteger(s)).toBe(true);

          // O comprador nunca paga mais do que pagaria sem a política.
          expect(item + (frete - s)).toBeLessThanOrEqual(item + frete);
          // E o frete cobrado nunca fica negativo.
          expect(frete - s).toBeGreaterThanOrEqual(0);

          // Take líquido da Kolecta ≥ 4% do item (piso da política).
          if (item > 0) {
            const liquido = item * COMISSAO - s;
            expect(liquido / item).toBeGreaterThanOrEqual(0.04 - 1e-9);
          }
        }
      }
    });

    it('S nunca passa do que o selo prometeu', () => {
      for (let item = 0; item <= 200_000; item += 3_100) {
        const prometido = subsidioMaximoEmCentavos(item, LIGADA);
        for (let frete = 0; frete <= 6_000; frete += 211) {
          expect(subsidioEmCentavos(item, frete, LIGADA)).toBeLessThanOrEqual(
            prometido,
          );
        }
      }
    });
  });

  describe('entradas degeneradas', () => {
    it('frete zero (retirada em mãos) não gera subsídio', () => {
      expect(subsidioEmCentavos(50_000, 0, LIGADA)).toBe(0);
    });

    it('valores não-finitos não derrubam o cálculo', () => {
      expect(subsidioEmCentavos(NaN, 1_300, LIGADA)).toBe(0);
      expect(subsidioEmCentavos(30_000, NaN, LIGADA)).toBe(0);
      expect(subsidioEmCentavos(-100, 1_300, LIGADA)).toBe(0);
      expect(subsidioEmCentavos(30_000, -50, LIGADA)).toBe(0);
    });
  });

  describe('os números do documento aos vendedores', () => {
    it('ticket médio real (R$ 165,23, frete R$ 13,76) → subsídio R$ 11,57 e take 4,0%', () => {
      const item = 16_523;
      const frete = 1_376;
      const s = subsidioEmCentavos(item, frete, LIGADA);

      expect(reais(s)).toBeCloseTo(11.57, 2);

      const comissao = item * 0.11;
      expect(reais(comissao)).toBeCloseTo(18.18, 2);
      expect(reais(comissao - s)).toBeCloseTo(6.61, 2);
      expect((comissao - s) / item).toBeCloseTo(0.04, 3);
    });
  });

  describe('politicaDoAmbiente', () => {
    const envOriginal = { ...process.env };
    afterEach(() => {
      process.env = { ...envOriginal };
    });

    it('vem DESLIGADA quando o env não diz nada', () => {
      delete process.env.FRETE_SUBSIDIO_ATIVO;
      expect(politicaDoAmbiente().ativo).toBe(false);
    });

    it('só liga com a string exata "true"', () => {
      process.env.FRETE_SUBSIDIO_ATIVO = 'sim';
      expect(politicaDoAmbiente().ativo).toBe(false);
      process.env.FRETE_SUBSIDIO_ATIVO = 'TRUE';
      expect(politicaDoAmbiente().ativo).toBe(true);
    });

    it('usa os defaults da política quando o valor é inválido', () => {
      process.env.FRETE_SUBSIDIO_PERCENT = 'abacaxi';
      process.env.FRETE_SUBSIDIO_TETO_EM_CENTAVOS = '';
      const p = politicaDoAmbiente();
      expect(p.percentualDoItem).toBe(7);
      expect(p.tetoEmCentavos).toBe(3000);
      expect(p.pisoDoItemEmCentavos).toBe(10000);
    });

    it('aceita a política sendo afrouxada ou apertada pelo env', () => {
      process.env.FRETE_SUBSIDIO_ATIVO = 'true';
      process.env.FRETE_SUBSIDIO_PERCENT = '5';
      process.env.FRETE_SUBSIDIO_PISO_ITEM_EM_CENTAVOS = '5000';
      const p = politicaDoAmbiente();
      // Item R$ 60 passa a ser elegível, e o teto vira 5%.
      expect(subsidioEmCentavos(6_000, 1_376, p)).toBe(300);
    });
  });
});
