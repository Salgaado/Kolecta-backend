import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const DISPUTE_REASONS = [
  'not_received',
  'different_item',
  'defective',
  'wrong_charge',
] as const;

export class CreateDisputeDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsIn(DISPUTE_REASONS as unknown as string[])
  reason: string;

  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  description: string;
}

export class AddDisputeMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content: string;
}
