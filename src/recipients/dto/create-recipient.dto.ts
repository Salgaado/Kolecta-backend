import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Conta bancária de repasse (default_bank_account na Pagar.me). */
export class BankAccountDto {
  @IsString()
  @IsNotEmpty()
  holderName: string;

  // Titular: pessoa física ou jurídica
  @IsIn(['individual', 'company'])
  holderType: string;

  // CPF (11) ou CNPJ (14) do titular — só dígitos
  @Matches(/^\d{11}$|^\d{14}$/, {
    message: 'holderDocument deve ser CPF (11) ou CNPJ (14) dígitos',
  })
  holderDocument: string;

  // Código do banco (3 dígitos, ex: "341" Itaú, "001" BB)
  @Matches(/^\d{3}$/, { message: 'bank deve ter 3 dígitos' })
  bank: string;

  @IsString()
  @IsNotEmpty()
  branchNumber: string;

  @IsOptional()
  @IsString()
  branchCheckDigit?: string;

  @IsString()
  @IsNotEmpty()
  accountNumber: string;

  @IsString()
  @IsNotEmpty()
  accountCheckDigit: string;

  // Conta corrente ou poupança
  @IsIn(['checking', 'savings'])
  accountType: string;
}

/**
 * Onboarding de recebedor. Campos pessoais extras (PF) são opcionais aqui —
 * a Pagar.me pode pedir o complemento na própria etapa de KYC/prova de vida.
 */
export class CreateRecipientDto {
  @IsIn(['individual', 'company'])
  type: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  // CPF (11) ou CNPJ (14) — só dígitos. Validação de dígito no service.
  @Matches(/^\d{11}$|^\d{14}$/, {
    message: 'document deve ser CPF (11) ou CNPJ (14) dígitos',
  })
  document: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  motherName?: string;

  // ISO date YYYY-MM-DD
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthdate deve ser YYYY-MM-DD' })
  birthdate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyIncomeInCents?: number;

  @IsOptional()
  @IsString()
  professionalOccupation?: string;

  // Telefone (só dígitos, com DDD): ex 11999998888
  @IsOptional()
  @Matches(/^\d{10,11}$/, {
    message: 'phone deve ter DDD + número (10-11 dígitos)',
  })
  phone?: string;

  @ValidateNested()
  @Type(() => BankAccountDto)
  bankAccount: BankAccountDto;
}
