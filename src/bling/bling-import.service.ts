import { Inject, Injectable, BadRequestException, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { BlingService } from './bling.service';
import { MediaService } from '../media/media.service';
import { produtoParaLinha } from './bling-catalogo';
import {
  validateImportRow,
  mapImportRow,
  parsePhotos,
  CATEGORY_SLUGS,
  CONDITION_VALUES,
} from '../listings/import-rules';

/**
 * Importa produtos do Bling do lojista como anúncios da Kolecta.
 *
 * Passa pela MESMA validação da planilha (`listings/import-rules.ts`), de
 * propósito: o produto do Bling vira uma linha no formato do CSV e é conferido
 * pelas mesmas regras. Assim o vendedor recebe exatamente as mesmas mensagens,
 * venha o anúncio de um arquivo ou do ERP dele, e não existe uma segunda lista
 * de regras para desalinhar depois.
 *
 * O que o Bling NÃO tem (categoria da Kolecta, condição) vem escolhido pelo
 * lojista, para o lote inteiro. O que ele também não tem e a categoria exige
 * (escala, personagem, jogo) aparece na conferência como pendência, produto a
 * produto, ANTES de qualquer anúncio ser criado.
 */
@Injectable()
export class BlingImportService {
  private readonly logger = new Logger(BlingImportService.name);

  /**
   * Teto por chamada.
   *
   * Era 30, calculado só sobre o custo de ler o detalhe no Bling (3 requisições
   * por segundo). A conta ignorava a parte cara: importar TAMBÉM baixa cada
   * foto da S3 do Bling e sobe para o nosso R2.
   *
   * Medido em produção com produto real de 5 fotos: 3,2s por produto com as
   * cópias em paralelo (eram 8,3s em série). Trinta produtos dariam uns 96
   * segundos e o Render corta requisição longa, deixando o lojista sem resposta
   * e sem saber o que foi criado.
   *
   * 15 dá uns 48 segundos, que cabe. A tela pagina sem o lojista perceber, e
   * lote maior de verdade pede job em segundo plano.
   */
  static readonly MAX_POR_LOTE = 15;

  /** Intervalo entre chamadas ao Bling. 350ms deixa folga sob o teto de 3/s. */
  private static readonly INTERVALO_MS = 350;

  constructor(
    private readonly bling: BlingService,
    private readonly media: MediaService,
    @Inject(DATABASE_CONNECTION) private readonly db: any,
  ) {}

  /**
   * Confere um lote SEM criar nada.
   *
   * Existe separado do importar porque descobrir que 30 dos 200 produtos estão
   * sem a segunda foto tem que acontecer na tela, não depois, com os anúncios
   * já criados e travados na análise.
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
        blingProductId: i.blingProductId,
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
   * Cria os anúncios dos produtos que passam. Os que não passam são devolvidos
   * com o motivo, e NÃO viram anúncio pela metade.
   *
   * Nascem em `pending_review`, igual à planilha: importar não publica.
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

    const criados: Array<{ blingProductId: number; titulo: string; aviso?: string }> = [];
    const recusados: Array<{ blingProductId: number; titulo: string; motivos: string[] }> = [];

    for (const item of itens) {
      if (item.jaImportado) {
        recusados.push({
          blingProductId: item.blingProductId,
          titulo: item.titulo,
          motivos: ['Este produto já virou anúncio antes.'],
        });
        continue;
      }
      if (item.pendencias.length > 0) {
        recusados.push({
          blingProductId: item.blingProductId,
          titulo: item.titulo,
          motivos: item.pendencias,
        });
        continue;
      }

      // As fotos do Bling vêm em URL ASSINADA que expira em 7 dias. Guardar o
      // link faria toda foto importada morrer na semana seguinte, e o vendedor
      // descobriria pela vitrine. Então o arquivo é copiado para o nosso R2
      // AQUI, na hora de criar, e não na conferência: conferir 200 produtos não
      // pode significar baixar 200 imagens que talvez ninguém importe.
      // `linha.images` é CSV, no formato da planilha. Quem transforma em JSON é
      // o `mapImportRow`, mais abaixo. Eu já chamei `JSON.parse` aqui e o
      // primeiro import de verdade morreu com 500: os 21 testes de unidade
      // passavam porque nenhum exercitava este caminho com dado real.
      //
      // Em paralelo, e não uma de cada vez: uma medição real deu 8,3s para um
      // produto de 5 fotos em série, o que daria 4 minutos num lote de 30 e
      // estouraria o tempo da requisição. Aqui não há limite de taxa a
      // respeitar (o Bling já entregou as URLs; o resto é a S3 deles e o nosso
      // R2), diferente das chamadas à API deles, que continuam espaçadas.
      //
      // `filter(Boolean)` preserva a ORDEM: a primeira foto é a capa do
      // anúncio, e embaralhar trocaria a capa por uma foto de detalhe.
      const fotosNossas = (
        await Promise.all(
          parsePhotos(item.linha.images).map((url) =>
            this.media.copiarDeUrl(url, userId),
          ),
        )
      ).filter((u): u is string => !!u);

      if (fotosNossas.length === 0) {
        // Passou na conferência (o Bling dizia ter foto) e na hora de copiar
        // não veio nenhuma. Criar o anúncio sem foto seria pior: ele nasceria
        // travado na análise e o vendedor não saberia por quê.
        recusados.push({
          blingProductId: item.blingProductId,
          titulo: item.titulo,
          motivos: ['Não consegui copiar as fotos do Bling. Tente de novo em instantes.'],
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
        // O elo. Sem ele, reimportar duplicaria e sincronizar estoque seria
        // impossível. O índice único por (vendedor, produto) é o backstop.
        blingProductId: item.blingProductId,
      });
      // O ERP guarda uma imagem principal por produto, então importar com foto
      // única é o caso comum e a regra foi afrouxada para isso. Mas anúncio com
      // uma foto vende menos, e o lojista precisa saber DISSO, não descobrir
      // depois olhando a vitrine.
      const qtdFotos = JSON.parse(m.images || '[]').length;
      criados.push({
        blingProductId: item.blingProductId,
        titulo: item.titulo,
        aviso:
          qtdFotos <= 1
            ? 'Entrou com 1 foto só. Adicione mais uma para vender melhor.'
            : undefined,
      });
    }

    this.logger.log(
      `Bling: ${criados.length} anúncio(s) criado(s), ${recusados.length} recusado(s) para ${userId}.`,
    );
    return { criados, recusados };
  }

  // ── Núcleo compartilhado ───────────────────────────────────────────────────

  /**
   * Busca o detalhe de cada produto, traduz para linha e valida. Conferir e
   * importar usam exatamente este caminho, então a tela nunca promete um
   * resultado diferente do que a importação vai fazer.
   */
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
    if (unicos.length > BlingImportService.MAX_POR_LOTE) {
      throw new BadRequestException(
        `Importe até ${BlingImportService.MAX_POR_LOTE} produtos por vez.`,
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

    // Quem já virou anúncio, para não duplicar. Uma consulta só, não uma por
    // produto.
    const jaImportados = new Set<number>(
      (
        await this.db
          .select({ blingProductId: schema.listings.blingProductId })
          .from(schema.listings)
          .where(
            and(
              eq(schema.listings.sellerId, userId),
              inArray(schema.listings.blingProductId, unicos),
            ),
          )
      ).map((r: any) => Number(r.blingProductId)),
    );

    const itens: Array<{
      blingProductId: number;
      titulo: string;
      linha: Record<string, string>;
      pendencias: string[];
      jaImportado: boolean;
    }> = [];

    for (const [i, id] of unicos.entries()) {
      // Espaçado para caber no teto de 3 requisições por segundo do Bling.
      if (i > 0) await espera(BlingImportService.INTERVALO_MS);

      let detalhe: any;
      try {
        detalhe = await this.bling.detalharProduto(userId, id);
      } catch (err: any) {
        itens.push({
          blingProductId: id,
          titulo: `Produto ${id}`,
          linha: {},
          pendencias: [`O Bling não devolveu este produto: ${err?.message ?? err}`],
          jaImportado: false,
        });
        continue;
      }

      const linha = produtoParaLinha(detalhe, escolhas);
      const pendencias = validateImportRow(linha, 0).map((e) => e.mensagem);

      itens.push({
        blingProductId: id,
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
