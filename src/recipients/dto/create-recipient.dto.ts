import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateIf,
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
 * Endereço (address / main_address na Pagar.me). Exigido pela Circular BCB
 * 3.978/20 (contrato de recebedores de fev/2024): PF manda `address`, PJ manda
 * `main_address` e o `address` de cada representante legal. `complementary` e
 * `referencePoint` são opcionais na prática (a Pagar.me aceita string vazia).
 */
export class AddressDto {
  @IsString()
  @IsNotEmpty()
  street: string;

  @IsString()
  @IsNotEmpty()
  streetNumber: string;

  @IsString()
  @IsNotEmpty()
  neighborhood: string;

  @IsString()
  @IsNotEmpty()
  city: string;

  // UF (2 letras)
  @Matches(/^[A-Za-z]{2}$/, { message: 'state deve ser a UF com 2 letras' })
  state: string;

  // CEP — 8 dígitos, só números
  @Matches(/^\d{8}$/, { message: 'zipCode deve ter 8 dígitos' })
  zipCode: string;

  @IsOptional()
  @IsString()
  complementary?: string;

  @IsOptional()
  @IsString()
  referencePoint?: string;
}

/**
 * Representante legal de PJ (managing_partners[] na Pagar.me). Obrigatório para
 * recebedores Pessoa Jurídica no contrato de fev/2024.
 */
export class ManagingPartnerDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  // CPF do representante — só dígitos
  @Matches(/^\d{11}$/, { message: 'document do sócio deve ser CPF (11) dígitos' })
  document: string;

  @IsOptional()
  @IsString()
  motherName?: string;

  // ISO date YYYY-MM-DD
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'birthdate do sócio deve ser YYYY-MM-DD',
  })
  birthdate: string;

  // Renda mensal em centavos (convertida para reais no service)
  @IsInt()
  @Min(0)
  monthlyIncomeInCents: number;

  @IsString()
  @IsNotEmpty()
  professionalOccupation: string;

  // Declara-se representante legal do CNPJ (exigido pela Pagar.me)
  @IsBoolean()
  selfDeclaredLegalRepresentative: boolean;

  // Telefone (só dígitos, com DDD): ex 11999998888
  @IsOptional()
  @Matches(/^\d{10,11}$/, {
    message: 'phone do sócio deve ter DDD + número (10-11 dígitos)',
  })
  phone?: string;

  @ValidateNested()
  @Type(() => AddressDto)
  address: AddressDto;
}

/**
 * Onboarding de recebedor. A validação é CONDICIONAL ao `type`:
 * - `individual` (PF): exige `birthdate`, `motherName`, `monthlyIncomeInCents`,
 *   `professionalOccupation` e `address`.
 * - `company` (PJ): exige `annualRevenueInCents`, `corporationType`,
 *   `foundingDate`, `mainAddress` e ao menos um `managingPartners[]`.
 * Isso reflete o contrato de recebedores da Pagar.me (Circular BCB 3.978/20,
 * fev/2024). Sem esses campos o `POST /recipients` retorna 400.
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

  // Site do recebedor — recomendado pela Pagar.me. Deve incluir http(s)://
  @IsOptional()
  @Matches(/^https?:\/\/.+/, {
    message: 'siteUrl deve começar com http:// ou https://',
  })
  siteUrl?: string;

  // Telefone (só dígitos, com DDD): ex 11999998888
  @IsOptional()
  @Matches(/^\d{10,11}$/, {
    message: 'phone deve ter DDD + número (10-11 dígitos)',
  })
  phone?: string;

  // ── Pessoa Física (individual) ─────────────────────────────────────────────

  @ValidateIf((o) => o.type === 'individual')
  @IsString()
  @IsNotEmpty()
  motherName?: string;

  // ISO date YYYY-MM-DD
  @ValidateIf((o) => o.type === 'individual')
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthdate deve ser YYYY-MM-DD' })
  birthdate?: string;

  @ValidateIf((o) => o.type === 'individual')
  @IsInt()
  @Min(0)
  monthlyIncomeInCents?: number;

  @ValidateIf((o) => o.type === 'individual')
  @IsString()
  @IsNotEmpty()
  professionalOccupation?: string;

  @ValidateIf((o) => o.type === 'individual')
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  // ── Pessoa Jurídica (company) ───────────────────────────────────────────────

  // Receita anual em centavos (convertida para reais no service)
  @ValidateIf((o) => o.type === 'company')
  @IsInt()
  @Min(0)
  annualRevenueInCents?: number;

  // Tipo societário (ex.: "LTDA", "MEI", "SA")
  @ValidateIf((o) => o.type === 'company')
  @IsString()
  @IsNotEmpty()
  corporationType?: string;

  // Data de fundação — ISO YYYY-MM-DD
  @ValidateIf((o) => o.type === 'company')
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'foundingDate deve ser YYYY-MM-DD' })
  foundingDate?: string;

  @ValidateIf((o) => o.type === 'company')
  @ValidateNested()
  @Type(() => AddressDto)
  mainAddress?: AddressDto;

  @ValidateIf((o) => o.type === 'company')
  @IsArray()
  @ArrayMinSize(1, { message: 'PJ exige ao menos um representante legal' })
  @ValidateNested({ each: true })
  @Type(() => ManagingPartnerDto)
  managingPartners?: ManagingPartnerDto[];

  @ValidateNested()
  @Type(() => BankAccountDto)
  bankAccount: BankAccountDto;
}
