import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Conferência e importação usam o MESMO corpo de propósito: a tela precisa
 * poder conferir e depois importar exatamente o mesmo lote, sem chance de os
 * dois divergirem por um parâmetro esquecido.
 */
export class ImportarBlingDto {
  /** IDs dos produtos no Bling do lojista. */
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  ids: number[];

  /** Slug da categoria Kolecta. O Bling não tem esse conceito. */
  @IsString()
  categoria: string;

  /** Condição do item. O Bling também não tem. */
  @IsString()
  condicao: string;

  /**
   * Campos que a categoria exige e o ERP não guarda, valendo para o lote.
   *
   * Escala é o caso que travava tudo: o Bling não tem esse conceito, e sem ela
   * NENHUM produto de miniaturas passava. Medido em 06/08/2026 nas duas lojas
   * conectadas: 10 de 10 produtos recusados por "Escala é obrigatório".
   *
   * Preenche o que falta, não sobrescreve o que veio do produto.
   */
  @IsObject()
  @IsOptional()
  atributos?: Record<string, string>;
}
