import { Inject, Injectable, BadRequestException, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { TinyService } from './tiny.service';
import { MediaService } from '../media/media.service';
import { produtoParaLinha } from './tiny-catalogo';
import {
  validateImportRow,
  mapImportRow,
  parsePhotos,
  CATEGORY_SLUGS,
  CONDITION_VALUES,
} from '../listings/import-rules';

/**
 * Importa produtos do Tiny (Olist ERP) do lojista como anúncios da Kolecta.
 *
 * Espelha `BlingImportService`: o produto do Tiny vira uma linha no formato do
 * CSV e passa pelas MESMAS regras (`listings/import-rules.ts`). Assim o vendedor
 * recebe exatamente as mesmas mensagens, venha o anúncio de um arquivo, do Bling
 * ou do Tiny, e não existe uma segunda lista de regras para desalinhar depois.
 */
@Injectable()
export class TinyImportService {
  private readonly logger = new Logger(TinyImportService.name);

  /**
   * Teto por chamada. Igual ao Bling: importar baixa cada foto do ERP e sobe
   * para o nosso R2, e trinta produtos estourariam o tempo da requisição no
   * Render. 15 cabe; lote maior de verdade pede job em segundo plano.
   */
  static readonly MAX_POR_LOTE = 15;

  /**
   * Intervalo entre chamadas ao Tiny. O swagger não publica o teto de taxa da
   * API v3 (⚠️ confirmar na primeira loja real); 350ms é a mesma folga usada no
   * Bling e é conservador o bastante para não tomar 429.
   */
  private static readonly INTERVALO_MS = 350;

  constructor(
    private readonly tiny: TinyService,
    private readonly media: MediaService,
    @Inject(DATABASE_CONNECTION) private readonly db: any,
  ) {}

  /**
   * Confere um lote SEM criar nada. Descobrir que faltam fotos ou escala tem
   * que acontecer na tela, não depois com os anúncios já travados na análise.
   */
  async conferir(
    userId: string,
    ids: number[],
    escolhas: {
      categoria: string;
      condicao: string;
      atributos?: Record<string, string>;
    },
  ) {
    const { itens } = await this.avaliar(userId, ids, escolhas);
    return {
      itens: itens.map((i) => ({
        tinyProductId: i.tinyProductId,
        titulo: i.titulo,
        pendencias: i.pendencias,
        jaImportado: i.jaImportado,
        pronto: i.pendencias.length === 0 && !i.jaImportado,
      })),
      resumo: {
        total: itens.length,
        prontos: itens.filter((i) => !i.pendencias.length && !i.jaImportado).length,
        comPendencia: itens.filter((i) => i.pendencias.length > 0).length,
        jaImportados: itens.filter((i) => i.jaImportado).length,
      },
    };
  }

  /**
   * Cria os anúncios dos produtos que passam. Os que não passam voltam com o
   * motivo e NÃO viram anúncio pela metade. Nascem em `pending_review`, igual à
   * planilha: importar não publica.
   */
  async importar(
    userId: string,
    ids: number[],
    escolhas: {
      categoria: string;
      condicao: string;
      atributos?: Record<string, string>;
    },
  ) {
    const { itens, categoriaId } = await this.avaliar(userId, ids, escolhas);

    const criados: Array<{ tinyProductId: number; titulo: string; aviso?: string }> = [];
    const recusados: Array<{ tinyProductId: number; titulo: string; motivos: string[] }> = [];

    for (const item of itens) {
      if (item.jaImportado) {
        recusados.push({
          tinyProductId: item.tinyProductId,
          titulo: item.titulo,
          motivos: ['Este produto já virou anúncio antes.'],
        });
        continue;
      }
      if (item.pendencias.length > 0) {
        recusados.push({
          tinyProductId: item.tinyProductId,
          titulo: item.titulo,
          motivos: item.pendencias,
        });
        continue;
      }

      // As fotos do ERP podem vir em URL assinada que expira. Copia para o nosso
      // R2 AQUI, na hora de criar (não na conferência), em paralelo. `filter`
      // preserva a ordem: a primeira foto é a capa.
      const fotosNossas = (
        await Promise.all(
          parsePhotos(item.linha.images).map((url) =>
            this.media.copiarDeUrl(url, userId),
          ),
        )
      ).filter((u): u is string => !!u);

      if (fotosNossas.length === 0) {
        recusados.push({
          tinyProductId: item.tinyProductId,
          titulo: item.titulo,
          motivos: ['Não consegui copiar as fotos do Tiny. Tente de novo em instantes.'],
        });
        continue;
      }

      const m = { ...mapImportRow(item.linha), images: JSON.stringify(fotosNossas) };
      await this.db.insert(schema.listings).values({
        sellerId: userId,
        title: m.title,
        description: m.description,
        condition: m.condition,
        categoryId: categoriaId,
        priceInCents: m.priceInCents,
        images: m.images,
        weightGrams: m.weightGrams,
        widthCm: m.widthCm,
        heightCm: m.heightCm,
        lengthCm: m.lengthCm,
        brand: m.brand,
        scale: m.scale,
        line: m.line,
        year: m.year,
        edition: m.edition,
        sku: m.sku,
        stock: m.stock,
        attributes: m.attributes,
        type: 'direct',
        status: 'pending_review',
        // O elo com o ERP. Sem ele, reimportar duplicaria e sincronizar estoque
        // seria impossível. O índice único por (vendedor, produto) é o backstop.
        tinyProductId: item.tinyProductId,
      });

      const qtdFotos = JSON.parse(m.images || '[]').length;
      criados.push({
        tinyProductId: item.tinyProductId,
        titulo: item.titulo,
        aviso:
          qtdFotos <= 1
            ? 'Entrou com 1 foto só. Adicione mais uma para vender melhor.'
            : undefined,
      });
    }

    this.logger.log(
      `Tiny: ${criados.length} anúncio(s) criado(s), ${recusados.length} recusado(s) para ${userId}.`,
    );
    return { criados, recusados };
  }

  // ── Núcleo compartilhado ───────────────────────────────────────────────────

  private async avaliar(
    userId: string,
    ids: number[],
    escolhas: {
      categoria: string;
      condicao: string;
      atributos?: Record<string, string>;
    },
  ) {
    const unicos = [...new Set((ids ?? []).map(Number).filter(Number.isFinite))];
    if (unicos.length === 0) {
      throw new BadRequestException('Escolha pelo menos um produto.');
    }
    if (unicos.length > TinyImportService.MAX_POR_LOTE) {
      throw new BadRequestException(
        `Importe até ${TinyImportService.MAX_POR_LOTE} produtos por vez.`,
      );
    }
    if (!CATEGORY_SLUGS.includes(escolhas.categoria)) {
      throw new BadRequestException(
        `Categoria inválida. Use: ${CATEGORY_SLUGS.join(', ')}`,
      );
    }
    if (!CONDITION_VALUES.includes(escolhas.condicao)) {
      throw new BadRequestException(
        `Condição inválida. Use: ${CONDITION_VALUES.join(', ')}`,
      );
    }

    const [categoria] = await this.db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(eq(schema.categories.slug, escolhas.categoria));
    if (!categoria) {
      throw new BadRequestException(
        `Categoria "${escolhas.categoria}" não existe na Kolecta.`,
      );
    }

    // Quem já virou anúncio, para não duplicar. Uma consulta só.
    const jaImportados = new Set<number>(
      (
        await this.db
          .select({ tinyProductId: schema.listings.tinyProductId })
          .from(schema.listings)
          .where(
            and(
              eq(schema.listings.sellerId, userId),
              inArray(schema.listings.tinyProductId, unicos),
            ),
          )
      ).map((r: any) => Number(r.tinyProductId)),
    );

    const itens: Array<{
      tinyProductId: number;
      titulo: string;
      linha: Record<string, string>;
      pendencias: string[];
      jaImportado: boolean;
    }> = [];

    for (const [i, id] of unicos.entries()) {
      if (i > 0) await espera(TinyImportService.INTERVALO_MS);

      let detalhe: any;
      try {
        detalhe = await this.tiny.detalharProduto(userId, id);
      } catch (err: any) {
        itens.push({
          tinyProductId: id,
          titulo: `Produto ${id}`,
          linha: {},
          pendencias: [`O Tiny não devolveu este produto: ${err?.message ?? err}`],
          jaImportado: false,
        });
        continue;
      }

      const linha = produtoParaLinha(detalhe, escolhas);
      const pendencias = validateImportRow(linha, 0).map((e) => e.mensagem);

      itens.push({
        tinyProductId: id,
        titulo: linha.title || `Produto ${id}`,
        linha,
        pendencias,
        jaImportado: jaImportados.has(id),
      });
    }

    return { itens, categoriaId: categoria.id as string };
  }
}

function espera(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
