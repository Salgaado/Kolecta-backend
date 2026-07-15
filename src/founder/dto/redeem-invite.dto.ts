import { IsNotEmpty, IsString } from 'class-validator';

export class RedeemInviteDto {
  @IsString()
  @IsNotEmpty()
  code: string;
}
