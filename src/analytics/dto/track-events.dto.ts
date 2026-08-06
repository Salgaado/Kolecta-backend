import {
  IsArray,
  IsOptional,
  IsString,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TrackEventDto {
  @IsString()
  sessionId: string;

  @IsString()
  event: string;

  @IsOptional()
  @IsString()
  path?: string;

  @IsOptional()
  @IsString()
  listingId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  meta?: string;
}

export class TrackEventsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TrackEventDto)
  events: TrackEventDto[];
}
