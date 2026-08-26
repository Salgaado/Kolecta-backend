import { Inject, Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { BlingService } from './bling.service';
import {
  decidir,
  emLotes,
  porProduto,
  saldoUtil,
  type Atualizacao,
  type SaldoBling,
} from './estoque-sync';

/**
 * Segue o estoque do ERP do lojista.
 *
 * É a terceira perna da integração, e a que evita o prejuízo: importar traz o
 * catálogo, o pedido de venda devolve a saída, e isto aqui impede que a peça
 * vendida no balcão ou no Mercado Livre continue à venda na Kolecta.
 *
 * Puxa, não recebe. O Bling manda webhook, mas webhook exige app homologado e
 * um endereço público registrado, e enquanto o app está em análise não chega
 * nada. Puxar funciona desde o primeiro lojista conectado, e a decisão do que
 * fazer com cada saldo mora em `estoque-sync.ts`, testada à parte.
 */
@Injectable()
export class BlingEstoqueService {
  private readonly logger = new Logger(BlingEstoqueService.name);

  /** Folga sob o teto de 3 requisições por segundo do Bling. */
  private static readonly INTERVALO_MS = 350;

  constructor(
    private readonly bling: BlingService,
    @Inject(DATABASE_CONNECTION) private readonly db: any,
  ) {}

  /**
   * Sincroniza o catálogo de UM lojista. Devolve o que mudou, para a tela poder
   * dizer exatamente o que aconteceu em vez de um "pronto" vazio.
   */
  async sincronizar(userId: string) {
    const anuncios = await this.db
      .select({
        id: schema.listings.id,
        blingProductId: schema.listings.blingProductId,
        type: schema.listings.type,
        status: schema.listings.status,
        stock: schema.listings.stock,
        pausedByStock: schema.listings.pausedByStock,
        title: schema.listings.title,
      })
      .from(schema.listings)
      .where(
        and(
          eq(schema.listings.sellerId, userId),
          isNotNull(schema.listings.blingProductId),
        ),
      );

    if (anuncios.length === 0) {
      return { anuncios: 0, consultados: 0, atualizados: 0, pausados: 0, reativados: 0, mudancas: [] };
    }

    const token = await this.bling.getValidToken(userId);
    const ids: number[] = [
      ...new Set<number>(anuncios.map((a: any) => Number(a.blingProductId))),
    ];

    const saldos = new Map<number, SaldoBling>();
    for (const [i, lote] of emLotes(ids).entries()) {
      if (i > 0) await espera(BlingEstoqueService.INTERVALO_MS);
      for (const [id, saldo] of await this.saldos(token, lote)) {
        saldos.set(id, saldo);
      }
    }

    const mudancas: Array<Atualizacao & { titulo: string }> = [];
    for (const a of anuncios) {
      // `decidir` é comum aos dois ERPs e recebe o saldo já normalizado — o
      // formato do Bling (`saldoVirtualTotal`) é traduzido aqui, e não lá.
      const patch = decidir(
        { ...(a as any), erpProductId: a.blingProductId ?? null },
        saldoUtil(saldos.get(Number(a.blingProductId))),
      );
      if (patch) mudancas.push({ ...patch, titulo: a.title });
    }

    // Uma escrita por anúncio que MUDOU, e só. Carimbar o catálogo inteiro a
    // cada rodada embaralharia a vitrine, que ordena por atualização.
    for (const m of mudancas) {
      const set: Record<string, unknown> = { stock: m.stock, updatedAt: new Date() };
      if (m.status) set.status = m.status;
      if (m.pausedByStock !== undefined) set.pausedByStock = m.pausedByStock;
      await this.db
        .update(schema.listings)
        .set(set)
        .where(eq(schema.listings.id, m.id));
    }

    const resultado = {
      anuncios: anuncios.length,
      consultados: saldos.size,
      atualizados: mudancas.length,
      pausados: mudancas.filter((m) => m.motivo === 'zerou').length,
      reativados: mudancas.filter((m) => m.motivo === 'voltou').length,
      mudancas: mudancas.map((m) => ({
        titulo: m.titulo,
        estoque: m.stock,
        motivo: m.motivo,
      })),
    };

    this.logger.log(
      `Bling estoque ${userId}: ${resultado.anuncios} anúncio(s), ` +
        `${resultado.atualizados} atualizado(s), ${resultado.pausados} pausado(s), ` +
        `${resultado.reativados} reativado(s).`,
    );
    return resultado;
  }

  /** Um lote de saldos. Erro do Bling vira exceção clara, não saldo zero. */
  private async saldos(token: string, ids: number[]): Promise<Map<number, SaldoBling>> {
    const qs = ids.map((i) => `idsProdutos[]=${i}`).join('&');
    const res = await fetch(
      `https://api.bling.com.br/Api/v3/estoques/saldos?${qs}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (!res.ok) {
      const corpo = await res.text();
      this.logger.error(
        `Bling /estoques/saldos ${res.status} (${ids.length} ids): ${corpo.slice(0, 300)}`,
      );
      throw new BadGatewayException(
        'Não foi possível ler o estoque do seu Bling. Tente de novo em instantes.',
      );
    }
    const { data } = await res.json();
    return porProduto(Array.isArray(data) ? data : []);
  }

  // ── Rodada automática ─────────────────────────────────────────────────────

  /**
   * De meia em meia hora, para todo lojista conectado.
   *
   * O intervalo é o que dá para prometer sem depender de webhook: meia hora é
   * curto o bastante para que a peça vendida em outro canal não fique um dia
   * inteiro à venda aqui, e longo o bastante para o custo ser irrisório. Com
   * lotes de 100 produtos, um catálogo de mil produtos são dez chamadas, bem
   * abaixo do teto diário do Bling.
   *
   * Um lojista com problema (token revogado, Bling fora do ar) NÃO pode derrubar
   * a rodada dos outros, então cada um é isolado no try.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async rodada() {
    const conexoes = await this.db
      .select({ userId: schema.blingConnections.userId })
      .from(schema.blingConnections);

    if (conexoes.length === 0) return;

    let ok = 0;
    let falhas = 0;
    for (const c of conexoes) {
      try {
        await this.sincronizar(c.userId);
        ok++;
      } catch (err: any) {
        falhas++;
        this.logger.error(
          `Sincronização de estoque falhou para ${c.userId}: ${err?.message ?? err}`,
        );
      }
      await espera(BlingEstoqueService.INTERVALO_MS);
    }
    this.logger.log(
      `Bling estoque: rodada em ${conexoes.length} loja(s), ${ok} ok, ${falhas} com falha.`,
    );
  }
}

function espera(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
