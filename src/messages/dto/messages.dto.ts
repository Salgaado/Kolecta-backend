import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class StartConversationDto {
  @IsString()
  @IsNotEmpty()
  listingId: string;

  @IsString()
  @IsNotEmpty()
  message: string;
}

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  content: string;
}
