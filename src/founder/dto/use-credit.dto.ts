import { IsNotEmpty, IsString } from 'class-validator';

export class UseCreditDto {
  @IsString()
  @IsNotEmpty()
  listingId: string;
}
