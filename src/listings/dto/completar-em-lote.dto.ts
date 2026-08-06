import { ArrayNotEmpty, IsArray, IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * PATCH /api/listings/completar — preenche campos vazios de vários anúncios.
 *
 * Nasceu da importação do Bling: linha, ano e edição ficam vazios e são eles que
 * alimentam a busca e os filtros. Editar cem anúncios um por um não é opção.
 */
export class CompletarEmLoteDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids: string[];

  /**
   * Campo para valor. Coluna própria (brand, line, scale, year, edition) ou
   * chave de categoria (jogo, personagem, numero…), tratadas no mesmo lugar.
   *
   * Valor vazio significa "não mexe", nunca "apaga".
   */
  @IsObject()
  valores: Record<string, string>;

  /**
   * Padrão false: preenche o vazio e não toca no que já tem valor.
   *
   * `true` existe para o caso legítimo de corrigir em massa, quando o vendedor
   * digitou a linha errada em trinta anúncios. Fora disso, sobrescrever apagaria
   * o dado bom de quem já estava certo.
   */
  @IsBoolean()
  @IsOptional()
  sobrescrever?: boolean;
}
