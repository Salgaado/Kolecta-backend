import { Injectable, Inject } from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { gte } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

export interface EventInput {
  sessionId: string;
  event: string;
  path?: string;
  listingId?: string;
  userId?: string;
  meta?: string;
}

const DIA_MS = 24 * 60 * 60 * 1000;
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

/**
 * Funil de tráfego próprio: guarda evento de comportamento e devolve conversão
 * por etapa, abandono de carrinho, tempo médio de sessão e quem está online.
 * É o funil interno do painel, não o Google Analytics (que mede SEO/ads à parte).
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  /** Grava um lote de eventos. Corta campos longos e ignora o que vier vazio. */
  async ingest(events: EventInput[]) {
    const rows = (events ?? [])
      .slice(0, 50)
      .map((e) => ({
        sessionId: String(e.sessionId ?? '').slice(0, 64),
        event: String(e.event ?? '').slice(0, 48),
        path: e.path ? String(e.path).slice(0, 256) : null,
        listingId: e.listingId ? String(e.listingId).slice(0, 64) : null,
        userId: e.userId ? String(e.userId).slice(0, 64) : null,
        meta: e.meta ? String(e.meta).slice(0, 2000) : null,
        createdAt: new Date(),
      }))
      .filter((r) => r.sessionId && r.event);
    if (rows.length) await this.db.insert(schema.analyticsEvents).values(rows);
    return { ok: true, stored: rows.length };
  }

  /** Agrega o funil dos últimos `days` dias. */
  async getTraffic(days: number) {
    const d = Math.min(Math.max(Math.round(days || 7), 1), 90);
    const since = new Date(Date.now() - d * DIA_MS);

    const rows = await this.db
      .select({
        sessionId: schema.analyticsEvents.sessionId,
        event: schema.analyticsEvents.event,
        createdAt: schema.analyticsEvents.createdAt,
      })
      .from(schema.analyticsEvents)
      .where(gte(schema.analyticsEvents.createdAt, since))
      .limit(100000);

    // ── Por sessão: eventos vistos, primeiro e último instante ──
    interface Sessao {
      eventos: Set<string>;
      first: number;
      last: number;
    }
    const sessoes = new Map<string, Sessao>();
    let pageViews = 0;
    const agora = Date.now();
    const onlineDesde = agora - 5 * 60 * 1000; // 5 min
    const online = new Set<string>();
    // DAU: sessões distintas por dia.
    const porDia = new Map<string, Set<string>>();

    for (const r of rows) {
      const t = new Date(r.createdAt as any).getTime();
      if (r.event === 'page_view') pageViews++;
      let s = sessoes.get(r.sessionId);
      if (!s) {
        s = { eventos: new Set(), first: t, last: t };
        sessoes.set(r.sessionId, s);
      }
      s.eventos.add(r.event);
      if (t < s.first) s.first = t;
      if (t > s.last) s.last = t;
      if (t >= onlineDesde) online.add(r.sessionId);
      const diaKey = new Date(t).toISOString().slice(0, 10);
      if (!porDia.has(diaKey)) porDia.set(diaKey, new Set());
      porDia.get(diaKey)!.add(r.sessionId);
    }

    const todas = [...sessoes.values()];
    const visitantes = sessoes.size;

    // ── Funil (sessões distintas que chegaram a cada etapa) ──
    const teve = (ev: string) => todas.filter((s) => s.eventos.has(ev)).length;
    const viramProduto = teve('view_product');
    const carrinho = teve('add_to_cart');
    const checkout = teve('checkout_start');
    const compra = teve('purchase_complete');

    const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);
    const funil = [
      { etapa: 'Visitantes', sessoes: visitantes, doTopo: 100, daAnterior: 100 },
      { etapa: 'Viram um produto', sessoes: viramProduto, doTopo: pct(viramProduto, visitantes), daAnterior: pct(viramProduto, visitantes) },
      { etapa: 'Adicionaram ao carrinho', sessoes: carrinho, doTopo: pct(carrinho, visitantes), daAnterior: pct(carrinho, viramProduto) },
      { etapa: 'Iniciaram checkout', sessoes: checkout, doTopo: pct(checkout, visitantes), daAnterior: pct(checkout, carrinho) },
      { etapa: 'Compraram', sessoes: compra, doTopo: pct(compra, visitantes), daAnterior: pct(compra, checkout) },
    ];

    // Abandono de carrinho: pôs no carrinho e não comprou.
    const abandonaramCarrinho = todas.filter(
      (s) => s.eventos.has('add_to_cart') && !s.eventos.has('purchase_complete'),
    ).length;
    const taxaAbandonoCarrinho = pct(abandonaramCarrinho, carrinho);

    // Tempo médio de sessão (só sessões com mais de um instante).
    const comDuracao = todas.filter((s) => s.last > s.first);
    const tempoMedioSegundos =
      comDuracao.length > 0
        ? Math.round(comDuracao.reduce((acc, s) => acc + (s.last - s.first) / 1000, 0) / comDuracao.length)
        : 0;

    // Taxa de rejeição (bounce): sessão com um único evento.
    const bounce = todas.filter((s) => s.eventos.size <= 1 && s.first === s.last).length;
    const taxaRejeicao = pct(bounce, visitantes);

    // DAU: série dos últimos `days` dias.
    const dau: { dia: string; label: string; sessoes: number }[] = [];
    for (let i = d - 1; i >= 0; i--) {
      const dt = new Date(agora - i * DIA_MS);
      const key = dt.toISOString().slice(0, 10);
      dau.push({
        dia: key,
        label: `${dt.getDate()}/${MESES[dt.getMonth()]}`,
        sessoes: porDia.get(key)?.size ?? 0,
      });
    }

    return {
      periodoDias: d,
      visitantes,
      pageViews,
      onlineAgora: online.size,
      tempoMedioSegundos,
      taxaRejeicao,
      taxaAbandonoCarrinho,
      abandonaramCarrinho,
      funil,
      dau,
      // Quando ainda não há evento, o front mostra o estado "coletando".
      coletando: rows.length === 0,
    };
  }
}
