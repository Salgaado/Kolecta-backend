import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAuctionDto {
  @IsString()
  @IsNotEmpty()
  listingId: string;

  @IsInt()
  @Min(0)
  @Type(() => Number)
  startingBidInCents: number;

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

  @IsOptional()
  @IsBoolean()
  antiSniper?: boolean;
}

export class PlaceBidDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  amountInCents: number;
}
