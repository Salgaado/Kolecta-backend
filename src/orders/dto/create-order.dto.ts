import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsCpf } from '../../common/validators/is-cpf.validator';

export class OrderItemDto {
  @IsString()
  @IsNotEmpty()
  listingId: string;
}

export class CreateOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  @ArrayMinSize(1)
  items: OrderItemDto[];

  @IsString()
  @IsOptional()
  addressId?: string;

  @IsBoolean()
  @IsOptional()
  useWalletBalance?: boolean;

  // CPF do comprador (exigido pela Pagar.me na transação). Opcional por ora —
  // o fluxo 100% wallet ainda não obriga; o frontend passa a enviar no checkout.
  @IsCpf()
  @IsOptional()
  buyerCpf?: string;

  // Telefone do comprador (DDD + número, só dígitos). Exigido pela Pagar.me para
  // gerar o PIX ("At least one customer phone is required"). Opcional no DTO
  // porque o fluxo 100% wallet não gera cobrança externa.
  @IsString()
  @IsOptional()
  buyerPhone?: string;
}

export class UpdateOrderStatusDto {
  @IsString()
  @IsNotEmpty()
  status: string;

  @IsString()
  @IsOptional()
  trackingCode?: string;
}
