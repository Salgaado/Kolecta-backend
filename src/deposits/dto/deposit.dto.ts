import { IsInt, IsString, Matches, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { IsCpf } from '../../common/validators/is-cpf.validator';

export class CreateDepositDto {
  /** Valor do depósito em centavos. Limites de negócio (R$5–R$100k) validados no controller. */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  amountInCents: number;

  /**
   * CPF do pagador — obrigatório pela Pagar.me para cobrança PIX.
   * Aceita com ou sem máscara; normalizado para 11 dígitos e validado pelo
   * dígito verificador (a Pagar.me rejeita CPF inválido com "Erro no gateway").
   */
  @Transform(({ value }) => String(value ?? '').replace(/\D/g, ''))
  @IsString()
  @IsCpf()
  cpf: string;

  /**
   * Telefone com DDD — obrigatório pela Pagar.me para cobrança PIX.
   * Aceita com ou sem máscara; normalizado para 10 ou 11 dígitos (DDD + número).
   */
  @Transform(({ value }) => String(value ?? '').replace(/\D/g, ''))
  @IsString()
  @Matches(/^\d{10,11}$/, {
    message: 'Telefone deve conter DDD + número (10 ou 11 dígitos).',
  })
  phone: string;
}
