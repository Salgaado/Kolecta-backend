import {
  IsString,
  IsNumber,
  IsOptional,
  Min,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class QuoteShippingDto {
  @IsString()
  @Length(8, 9)
  from_cep: string;

  @IsString()
  @Length(8, 9)
  to_cep: string;

  @IsNumber()
  @Min(0.1)
  @Type(() => Number)
  weight_kg: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  height_cm: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  width_cm: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  length_cm: number;

  @IsString()
  @IsOptional()
  listing_id?: string;
}

/** Dimensões/peso do volume a etiquetar. */
export class VolumesDto {
  @IsNumber()
  @Min(0.05)
  @Type(() => Number)
  weight_kg: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  width_cm: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  height_cm: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  length_cm: number;
}

/**
 * Geração de etiqueta (escopo "cart + link ao painel"). O pedido ainda não
 * persiste serviço/pacote/origem (ver follow-ups no plano), então esses dados
 * vêm no request. `to` é derivado do endereço de entrega do pedido; `from` é o
 * endereço do vendedor referenciado por `origin_address_id`.
 */
export class GenerateLabelDto {
  @IsString()
  order_id: string;

  /** ID do serviço Melhor Envio (vem do `raw.id` da cotação). */
  @IsNumber()
  @Type(() => Number)
  service_id: number;

  /** Endereço do vendedor (origem/coleta) — uma linha da tabela `addresses`. */
  @IsString()
  origin_address_id: string;

  @ValidateNested()
  @Type(() => VolumesDto)
  volumes: VolumesDto;

  /** Valor declarado em reais. Default = total do pedido. */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  declared_value?: number;

  /** CPF/CNPJ do comprador (destinatário). Preenchido pelo item #8 no futuro. */
  @IsOptional()
  @IsString()
  to_document?: string;

  /** CPF/CNPJ do vendedor (remetente). */
  @IsOptional()
  @IsString()
  from_document?: string;
}
