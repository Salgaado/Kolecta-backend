import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateListingDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  line?: string;

  @IsOptional()
  @IsString()
  scale?: string;

  @IsOptional()
  @IsString()
  year?: string;

  @IsOptional()
  @IsString()
  edition?: string;

  // lacrado | novo | mint | usado
  @IsString()
  @IsNotEmpty()
  condition: string;

  @IsIn(['direct', 'auction'])
  type: 'direct' | 'auction';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  priceInCents?: number;

  // ── Configuração de leilão (obrigatória quando type='auction') ──
  // O leilão nasce "parado" (endsAt=null) e o relógio só começa quando o admin
  // ativa o anúncio (ver ListingsService.updateStatus).
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  startingBidInCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  minIncrementInCents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  reservePriceInCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  durationHours?: number;

  // JSON array stringificado: '["url1","url2"]'
  @IsOptional()
  @IsString()
  images?: string;
}

// Atualização: todos os campos opcionais, exceto `type` (não pode mudar o tipo do anúncio).
export class UpdateListingDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  line?: string;

  @IsOptional()
  @IsString()
  scale?: string;

  @IsOptional()
  @IsString()
  year?: string;

  @IsOptional()
  @IsString()
  edition?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  condition?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  priceInCents?: number;

  @IsOptional()
  @IsString()
  images?: string;
}
