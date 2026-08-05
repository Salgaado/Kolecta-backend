import { ArrayNotEmpty, IsArray, IsInt, IsString } from 'class-validator';

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
}
