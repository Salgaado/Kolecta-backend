import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { TinyService } from './tiny.service';
import { decidir, type Atualizacao } from '../common/erp/estoque-sync';

/**
 * Segue o estoque do Tiny (Olist ERP) do lojista. Espelha `BlingEstoqueService`,
 * com uma diferença de API: o Tiny NÃO tem consulta de saldo em lote (o Bling
 * tem `/estoques/saldos`), então aqui é UM produto por chamada, espaçado.
 *
 * A decisão do que fazer com cada saldo (não tocar em leilão, não ressuscitar o
 * que a moderação recusou, distinguir pausa por falta de peça de pausa na mão)
 * é comum aos dois ERPs e vive em `common/erp/estoque-sync.ts`. Aqui em cima só
 * mora o que é do Tiny: como ler o saldo e o ritmo das chamadas.
 */
@Injectable()
export class TinyEstoqueService {
  private readonly logger = new Logger(TinyEstoqueService.name);

  /** Folga entre chamadas. Ver a nota de taxa em TinyImportService. */
  private static readonly INTERVALO_MS = 350;

  constructor(
    private readonly tiny: TinyService,
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
        tinyProductId: schema.listings.tinyProductId,
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
          isNotNull(schema.listings.tinyProductId),
        ),
      );

    if (anuncios.length === 0) {
      return { anuncios: 0, consultados: 0, atualizados: 0, pausados: 0, reativados: 0, mudancas: [] };
    }

    // Um produto por chamada (o Tiny não tem lote), espaçado. Deduplica ids
    // porque o mesmo produto pode ter mais de um anúncio.
    const ids = [
      ...new Set<number>(anuncios.map((a: any) => Number(a.tinyProductId))),
    ];
    const saldos = new Map<number, number | null>();
    for (const [i, id] of ids.entries()) {
      if (i > 0) await espera(TinyEstoqueService.INTERVALO_MS);
      saldos.set(id, await this.tiny.saldoProduto(userId, id));
    }

    const mudancas: Array<Atualizacao & { titulo: string }> = [];
    for (const a of anuncios) {
      const patch = decidir(
        { ...(a as any), erpProductId: a.tinyProductId ?? null },
        saldos.get(Number(a.tinyProductId)),
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
      consultados: [...saldos.values()].filter((v) => v !== null).length,
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
      `Tiny estoque ${userId}: ${resultado.anuncios} anúncio(s), ` +
        `${resultado.atualizados} atualizado(s), ${resultado.pausados} pausado(s), ` +
        `${resultado.reativados} reativado(s).`,
    );
    return resultado;
  }

  // ── Rodada automática ─────────────────────────────────────────────────────

  /**
   * De meia em meia hora, para todo lojista com Tiny conectado. Um lojista com
   * problema (token revogado, Tiny fora do ar) NÃO derruba a rodada dos outros:
   * cada um é isolado no try. Mesma cadência do Bling.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async rodada() {
    const conexoes = await this.db
      .select({ userId: schema.tinyConnections.userId })
      .from(schema.tinyConnections);

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
          `Sincronização de estoque Tiny falhou para ${c.userId}: ${err?.message ?? err}`,
        );
      }
      await espera(TinyEstoqueService.INTERVALO_MS);
    }
    this.logger.log(
      `Tiny estoque: rodada em ${conexoes.length} loja(s), ${ok} ok, ${falhas} com falha.`,
    );
  }
}

function espera(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
