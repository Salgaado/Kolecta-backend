/**
 * Interpreta o rastreio do Melhor Envio. Puro: sem HTTP, sem banco.
 *
 * O `/me/shipment/tracking` NÃO devolve os eventos cidade a cidade dos Correios.
 * Devolve MARCOS com data: quando a etiqueta foi gerada, quando o objeto entrou
 * na transportadora (postado) e quando foi entregue. É o suficiente para uma
 * linha do tempo clara, e é o que a plataforma mostra. O detalhe granular, se um
 * dia for preciso, sai da API da transportadora, à parte.
 *
 * Conferido contra a produção em 06/08/2026 com envio real (Correios PAC):
 *   { status: 'posted', tracking: 'AP...BR', generated_at, posted_at,
 *     delivered_at: null, canceled_at: null }
 */

/** Etapas visíveis do envio. Marcos, não eventos. */
export type EtapaRastreio =
  | 'pendente'
  | 'emitida'
  | 'postado'
  | 'entregue'
  | 'cancelado';

export interface MarcoRastreio {
  etapa: EtapaRastreio;
  /** No formato cru do Melhor Envio: "2026-08-04 14:18:16". */
  data: string | null;
}

export interface Rastreio {
  /** Status cru do Melhor Envio (posted, delivered, canceled...). */
  status: string;
  etapaAtual: EtapaRastreio;
  /** Código dos Correios/transportadora, para o link e o "copiar". */
  codigo: string | null;
  marcos: MarcoRastreio[];
  postadoEm: string | null;
  entregueEm: string | null;
  canceladoEm: string | null;
}

/** Um envio na resposta do /me/shipment/tracking. */
export interface RespostaRastreioME {
  status?: string | null;
  tracking?: string | null;
  generated_at?: string | null;
  posted_at?: string | null;
  delivered_at?: string | null;
  canceled_at?: string | null;
  expired_at?: string | null;
}

export function interpretarRastreio(
  bruto: RespostaRastreioME | null | undefined,
): Rastreio {
  const b = bruto ?? {};
  const emitida = limpo(b.generated_at);
  const postado = limpo(b.posted_at);
  const entregue = limpo(b.delivered_at);
  // Expirado e cancelado terminam o envio do mesmo jeito para quem olha a tela.
  const cancelado = limpo(b.canceled_at) ?? limpo(b.expired_at);

  const marcos: MarcoRastreio[] = [];
  if (emitida) marcos.push({ etapa: 'emitida', data: emitida });
  if (postado) marcos.push({ etapa: 'postado', data: postado });
  if (entregue) marcos.push({ etapa: 'entregue', data: entregue });

  // A etapa atual é o marco MAIS AVANÇADO alcançado. Cancelado ganha de tudo:
  // um envio cancelado depois de postado não está "a caminho".
  let etapaAtual: EtapaRastreio = 'pendente';
  if (cancelado) etapaAtual = 'cancelado';
  else if (entregue) etapaAtual = 'entregue';
  else if (postado) etapaAtual = 'postado';
  else if (emitida) etapaAtual = 'emitida';

  return {
    status: String(b.status ?? '').trim() || 'desconhecido',
    etapaAtual,
    codigo: limpo(b.tracking),
    marcos,
    postadoEm: postado,
    entregueEm: entregue,
    canceladoEm: cancelado,
  };
}

/**
 * Vazio, nulo ou a data-zero do Melhor Envio contam como "não aconteceu".
 *
 * Exportado porque quem consulta o ME precisa da MESMA régua para decidir se um
 * campo veio de verdade: o `/shipment/tracking` devolve ora `null`, ora `""`,
 * ora `"0000-00-00 00:00:00"` para dizer a mesma coisa. Reimplementar essa
 * regra do lado do HTTP é como o nulo escapa.
 */
export function limpo(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s || s.startsWith('0000')) return null;
  return s;
}

/**
 * Data do Melhor Envio para Date. Ele manda hora local de Brasília sem fuso, e
 * o Brasil está em UTC-3 sem horário de verão desde 2019: sem fixar o offset, o
 * servidor (em UTC) leria 3h adiantado e uma entrega da noite viraria do dia
 * seguinte.
 */
export function dataMEParaDate(data: string | null | undefined): Date | null {
  const s = limpo(data);
  if (!s) return null;
  const d = new Date(`${s.replace(' ', 'T')}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
