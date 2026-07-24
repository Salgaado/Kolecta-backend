import { IsNotEmpty, IsString } from 'class-validator';

export class SaveCardDto {
  // Token de uso único gerado NO FRONT via chave pública da Pagar.me (endpoint
  // /tokens). O número do cartão e o CVV NUNCA passam pelo nosso backend
  // (escopo PCI) — só o token chega aqui e é trocado por um card_id salvo.
  @IsString()
  @IsNotEmpty()
  cardToken: string;
}
