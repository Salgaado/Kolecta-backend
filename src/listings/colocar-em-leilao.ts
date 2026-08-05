// Regra de "colocar em leilão" — PURA, sem Nest e sem banco.
//
// O vendedor já tem o anúncio montado (fotos, descrição, medidas, atributos) e
// quer leiloar. Fazer ele preencher tudo de novo num anúncio novo é o trabalho
// que a função existe para evitar.
//
// O que decide entre CONVERTER e DUPLICAR é o estoque, e o motivo é risco de
// venda dupla, não preferência:
//
//   estoque 1  -> CONVERTE. É uma peça só. Duplicar criaria dois anúncios para
//                 o mesmo objeto físico, e o vendedor poderia vender duas
//                 vezes: disputa e estorno, não incômodo.
//   estoque >1 -> DUPLICA e tira 1 do original. Ele leiloa uma unidade e segue
//                 vendendo o resto na compra direta.
//
// De 1.027 anúncios ativos em 05/08/2026, só 126 tinham estoque maior que 1:
// converter é a regra, duplicar é a exceção. Para o vendedor é o mesmo botão.

export type AcaoLeilao = 'converter' | 'duplicar';

/** Status de pedido que ainda prende a peça a um comprador. */
const PEDIDO_EM_ABERTO = ['pending', 'pending_payment', 'paid', 'shipped'];

export interface EstadoDoAnuncio {
  type?: string | null;
  stock?: number | null;
  /** Status dos pedidos que existem para este anúncio. */
  statusDosPedidos?: string[];
}

/**
 * O que fazer com este anúncio. `null` em `acao` significa que não dá, e
 * `motivo` explica por quê, em texto pronto para a tela.
 */
export function decidirAcao(estado: EstadoDoAnuncio): {
  acao: AcaoLeilao | null;
  motivo: string | null;
} {
  if ((estado.type ?? 'direct') === 'auction') {
    return { acao: null, motivo: 'Este anúncio já é um leilão.' };
  }

  // Peça com pedido em aberto tem dono. Leiloar por cima significaria vender
  // para um segundo comprador algo que já saiu.
  const preso = (estado.statusDosPedidos ?? []).some((s) =>
    PEDIDO_EM_ABERTO.includes(String(s)),
  );
  if (preso) {
    return {
      acao: null,
      motivo:
        'Este anúncio tem pedido em aberto. Conclua ou cancele antes de leiloar.',
    };
  }

  // null e 0 contam como uma unidade: anúncio antigo entrou sem estoque e o
  // vendedor sempre tratou como peça única.
  const unidades = Number(estado.stock ?? 1);
  return {
    acao: Number.isFinite(unidades) && unidades > 1 ? 'duplicar' : 'converter',
    motivo: null,
  };
}

/**
 * Colunas do anúncio que a cópia leva.
 *
 * Lista explícita, e não "copia tudo menos": coluna nova que aparecer no schema
 * fica de fora até alguém decidir, o que é o lado seguro. Copiar por acidente
 * um `featuredUntil` daria destaque de graça, e copiar `blingProductId`
 * estouraria o índice único de (vendedor, produto).
 */
export const CAMPOS_COPIADOS = [
  'categoryId',
  'title',
  'description',
  'brand',
  'line',
  'scale',
  'year',
  'edition',
  'attributes',
  'condition',
  'images',
  'sku',
  'weightGrams',
  'widthCm',
  'heightCm',
  'lengthCm',
] as const;

/** Campos do leilão, com os mesmos padrões do wizard de criação. */
export interface ConfigLeilao {
  startingBidInCents: number;
  minIncrementInCents?: number | null;
  reservePriceInCents?: number | null;
  durationHours?: number | null;
  antiSniper?: boolean | null;
}

export function normalizarConfig(c: ConfigLeilao) {
  return {
    startingBidInCents: c.startingBidInCents,
    minIncrementInCents: c.minIncrementInCents ?? 1000,
    reservePriceInCents: c.reservePriceInCents ?? null,
    durationHours: c.durationHours ?? 48,
    antiSniper: c.antiSniper ?? true,
  };
}

/** Copia só o que está na lista, e nada mais. */
export function copiarCampos(origem: Record<string, unknown>) {
  const copia: Record<string, unknown> = {};
  for (const campo of CAMPOS_COPIADOS) copia[campo] = origem[campo];
  return copia;
}
