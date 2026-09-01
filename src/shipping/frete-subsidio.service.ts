import { Inject, Injectable, Logger } from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, gte, inArray, sql } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import {
  PoliticaSubsidio,
  politicaDoAmbiente,
  subsidioEmCentavos,
} from '../common/frete-subsidio';

/**
 * Teto de gasto do mês, em centavos. `0` (default) = sem teto.
 *
 * É a decisão D3 do plano virada mecanismo: o piloto foi escrito como *"vamos
 * gastar até R$ X e observar"*, e uma frase num documento não impede gasto
 * nenhum. Aqui impede.
 *
 * Também é o único anteparo real contra o furo de caixa: a Kolecta recebe
 * comissão + frete parcial pela Pagar.me, **com prazo de liquidação**, e paga a
 * etiqueta cheia **à vista**, debitando a carteira do Melhor Envio. O subsídio
 * drena essa carteira mais rápido do que a comissão a repõe, e saldo
 * insuficiente já é modo de falha conhecido (`orders.shipping_label_error`) —
 * com subsídio ele chega antes.
 */
const ORCAMENTO_MENSAL_EM_CENTAVOS = (() => {
  const bruto = process.env.FRETE_SUBSIDIO_ORCAMENTO_MENSAL_EM_CENTAVOS;
  const n = Number(bruto ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
})();

/** Status em que o pedido já custou dinheiro de verdade (a etiqueta foi comprada). */
const STATUS_QUE_JA_GASTARAM = [
  'paid',
  'shipped',
  'delivered',
  'completed',
] as const;

export interface FreteResolvido {
  /** Frete COBRADO do comprador — `F − S`. É o que vai para `shipping_in_cents`. */
  shippingInCents: number;
  /** Custo cheio da etiqueta — `F`. O que a Kolecta paga ao Melhor Envio. */
  shippingCostInCents: number;
  /** O que a Kolecta bancou — `S`, tirado da própria comissão. */
  shippingSubsidyInCents: number;
}

/**
 * Aplica a política de frete compartilhado a um pedido concreto.
 *
 * Mora no `ShippingModule` porque é ele quem já é importado pelos dois únicos
 * lugares onde o frete é ESCOLHIDO — `OrdersService.createCheckout` (venda
 * direta) e `AuctionsService.chooseShipping` (leilão). São esses dois, e só
 * esses, que precisam da fórmula: os outros quatro pontos que calculam
 * `platformFeeInCents` derivam do valor gravado e continuam corretos sozinhos
 * (ver `common/frete-subsidio.ts`).
 *
 * A regra pura vive em `common/frete-subsidio.ts`. Aqui em cima entram as duas
 * coisas que a regra não pode ter: o env e o orçamento.
 */
@Injectable()
export class FreteSubsidioService {
  private readonly logger = new Logger(FreteSubsidioService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  /** A política vigente, lida do ambiente a cada chamada (kill switch sem deploy). */
  politica(): PoliticaSubsidio {
    return politicaDoAmbiente();
  }

  /**
   * Quanto já foi subsidiado no mês corrente, em centavos.
   *
   * Conta pedidos que já custaram dinheiro (a etiqueta é comprada depois do
   * pagamento). Pedido pendente que ainda não foi pago não entra — ele pode
   * nunca ser pago —, o que faz o orçamento reagir com um atraso pequeno. Para
   * um freio de segurança isso é o comportamento certo: erra para o lado de
   * não bloquear venda por gasto que não aconteceu.
   */
  async gastoDoMesEmCentavos(): Promise<number> {
    const agora = new Date();
    const inicioDoMes = new Date(
      agora.getFullYear(),
      agora.getMonth(),
      1,
      0,
      0,
      0,
      0,
    );

    const [linha] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${schema.orders.shippingSubsidyInCents}), 0)`,
      })
      .from(schema.orders)
      .where(
        and(
          gte(schema.orders.createdAt, inicioDoMes),
          inArray(schema.orders.status, [...STATUS_QUE_JA_GASTARAM]),
        ),
      );

    return Number(linha?.total ?? 0);
  }

  /**
   * Resolve o frete de um pedido: quanto o comprador paga, quanto custa e
   * quanto a Kolecta bancou.
   *
   * `opcoesEmCentavos` são as opções ELEGÍVEIS da rota (o `quoteShipping` já
   * cortou as que exigem nota fiscal e as que o vendedor não aceita). A âncora
   * do subsídio é a mais barata delas — **não** a escolhida. Quem prefere uma
   * transportadora mais cara paga a diferença inteira; sem isso, cobertura de
   * 100% significa que todo mundo escolhe SEDEX e o subsídio sobe ~50%.
   *
   * Lista vazia (cotação indisponível, mock de desenvolvimento) → subsídio 0.
   * **Não se banca frete que não foi verificado.**
   */
  async resolver(params: {
    itemInCents: number;
    freteEscolhidoInCents: number;
    opcoesEmCentavos: number[];
    contexto: string;
  }): Promise<FreteResolvido> {
    const { itemInCents, freteEscolhidoInCents, opcoesEmCentavos } = params;

    const semSubsidio: FreteResolvido = {
      shippingInCents: freteEscolhidoInCents,
      shippingCostInCents: freteEscolhidoInCents,
      shippingSubsidyInCents: 0,
    };

    const politica = this.politica();
    if (!politica.ativo || freteEscolhidoInCents <= 0) return semSubsidio;

    const elegiveis = opcoesEmCentavos.filter(
      (c) => Number.isFinite(c) && c > 0,
    );
    if (elegiveis.length === 0) {
      this.logger.warn(
        `${params.contexto}: sem cotação confiável para ancorar o subsídio — ` +
          'cobrando o frete cheio. Nenhum subsídio é concedido sobre um valor ' +
          'que o servidor não verificou.',
      );
      return semSubsidio;
    }

    const maisBarato = Math.min(...elegiveis);
    const subsidio = subsidioEmCentavos(itemInCents, maisBarato, politica);
    if (subsidio <= 0) return semSubsidio;

    if (ORCAMENTO_MENSAL_EM_CENTAVOS > 0) {
      const gasto = await this.gastoDoMesEmCentavos();
      if (gasto + subsidio > ORCAMENTO_MENSAL_EM_CENTAVOS) {
        this.logger.warn(
          `${params.contexto}: orçamento de frete subsidiado do mês estourado ` +
            `(gasto R$ ${(gasto / 100).toFixed(2)} + R$ ${(subsidio / 100).toFixed(2)} ` +
            `> teto R$ ${(ORCAMENTO_MENSAL_EM_CENTAVOS / 100).toFixed(2)}). ` +
            'Cobrando o frete cheio.',
        );
        return semSubsidio;
      }
    }

    // O subsídio é ancorado na opção mais barata, então nunca supera o frete
    // escolhido — mas a subtração não pode nem em teoria ficar negativa: seria
    // um pedido em que o comprador "recebe" frete.
    const cobrado = Math.max(0, freteEscolhidoInCents - subsidio);
    const concedido = freteEscolhidoInCents - cobrado;

    this.logger.log(
      `${params.contexto}: frete cheio R$ ${(freteEscolhidoInCents / 100).toFixed(2)}, ` +
        `Kolecta banca R$ ${(concedido / 100).toFixed(2)} ` +
        `(${politica.percentualDoItem}% de R$ ${(itemInCents / 100).toFixed(2)}, ` +
        `âncora R$ ${(maisBarato / 100).toFixed(2)}), ` +
        `comprador paga R$ ${(cobrado / 100).toFixed(2)}.`,
    );

    return {
      shippingInCents: cobrado,
      shippingCostInCents: freteEscolhidoInCents,
      shippingSubsidyInCents: concedido,
    };
  }
}
