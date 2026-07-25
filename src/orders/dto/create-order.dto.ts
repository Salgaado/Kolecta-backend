import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
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

  // Frete escolhido pelo comprador, em centavos. Somado ao total cobrado e
  // repassado 100% ao vendedor no split (comissão só sobre o item).
  @IsInt()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  shippingInCents?: number;

  // Serviço do Melhor Envio escolhido pelo comprador (`raw.id` da cotação) e o
  // nome legível ("PAC", "SEDEX", "Jadlog .Package"). Sem isso só sabemos
  // QUANTO foi cobrado, não POR QUAL transportadora — e a etiqueta automática
  // sairia de um serviço diferente do que o comprador pagou.
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  shippingServiceId?: number;

  @IsString()
  @IsOptional()
  shippingServiceName?: string;

  // 'shipping' (envio) | 'pickup' (retirada pessoal). Em pickup não há frete e o
  // saldo libera na hora quando o comprador confirma o recebimento.
  @IsIn(['shipping', 'pickup'])
  @IsOptional()
  deliveryMethod?: 'shipping' | 'pickup';

  @IsBoolean()
  @IsOptional()
  useWalletBalance?: boolean;

  // Instrumento da parte cobrada via gateway. Default 'pix' quando ausente
  // (compatibilidade com o checkout PIX atual).
  @IsIn(['pix', 'credit_card'])
  @IsOptional()
  paymentMethod?: 'pix' | 'credit_card';

  // Token do cartão gerado NO FRONT via chave pública Pagar.me (endpoint
  // /tokens). O número do cartão NUNCA passa pelo nosso backend (escopo PCI).
  // Obrigatório quando paymentMethod === 'credit_card'.
  @IsString()
  @IsOptional()
  cardToken?: string;

  // Nº de parcelas no cartão (1 = à vista, sem juros). Juros a partir de 2x
  // são custo do comprador. Limitado a 12x.
  @IsInt()
  @Min(1)
  @Max(12)
  @IsOptional()
  @Type(() => Number)
  installments?: number;

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

  // 'shipping' (envio) | 'pickup' (retirada pessoal). Em pickup, a confirmação
  // do comprador libera o saldo na hora (sem a janela de 48h).
  @IsIn(['shipping', 'pickup'])
  @IsOptional()
  deliveryMethod?: 'shipping' | 'pickup';
}
