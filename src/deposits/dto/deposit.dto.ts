import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateDepositDto {
  /** Valor do depósito em centavos. Limites de negócio (R$5–R$100k) validados no controller. */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  amountInCents: number;
}
