import { IsString, IsNumber, IsOptional, Min, Length } from 'class-validator';
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

export class GenerateLabelDto {
  @IsString()
  order_id: string;
}
