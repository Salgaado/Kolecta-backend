import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

/**
 * Configuração do leilão ao transformar um anúncio de compra direta.
 *
 * Só o lance inicial é obrigatório; o resto cai nos mesmos padrões do wizard de
 * criação (incremento de R$ 10, 48h, anti-sniper ligado).
 */
export class ColocarEmLeilaoDto {
  @IsInt()
  @Min(1)
  startingBidInCents: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minIncrementInCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  reservePriceInCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  durationHours?: number;

  @IsOptional()
  @IsBoolean()
  antiSniper?: boolean;
}
