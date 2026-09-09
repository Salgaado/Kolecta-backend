import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Conferência e importação usam o MESMO corpo de propósito (igual ao Bling): a
 * tela precisa conferir e depois importar exatamente o mesmo lote, sem chance
 * de os dois divergirem por um parâmetro esquecido.
 */
export class ImportarTinyDto {
  /** IDs dos produtos no Tiny do lojista. */
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  ids: number[];

  /** Slug da categoria Kolecta. O Tiny não tem esse conceito. */
  @IsString()
  categoria: string;

  /** Condição do item. O Tiny também não tem. */
  @IsString()
  condicao: string;

  /**
   * Campos que a categoria exige e o ERP não guarda, valendo para o lote.
   * Escala é o caso que trava tudo em miniaturas. Preenche o que falta, não
   * sobrescreve o que veio do produto.
   */
  @IsObject()
  @IsOptional()
  atributos?: Record<string, string>;
}
