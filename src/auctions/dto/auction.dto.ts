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

/**
 * Escolha de entrega do VENCEDOR, depois do fecho do leilão.
 *
 * Leilão não tem checkout — o lance é só o valor da peça —, então a escolha do
 * frete acontece aqui, no pedido `pending_payment`, antes da cobrança. O total
 * cobrado passa a ser `lance + frete`.
 *
 * `shippingServiceId` é o id do serviço no Melhor Envio (o `raw.id` da cotação).
 * O PREÇO não vem no corpo de propósito: o servidor recota e usa o valor dele.
 * Aceitar o preço do cliente aqui seria deixar o comprador escolher quanto paga
 * de frete.
 */
export class ChooseAuctionShippingDto {
  /** 'shipping' (transportadora) ou 'pickup' (retirada em mãos). */
  @IsString()
  @IsNotEmpty()
  deliveryMethod: 'shipping' | 'pickup';

  /** Obrigatório quando `deliveryMethod = 'shipping'`. */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  shippingServiceId?: number;

  /**
   * Endereço de entrega. Opcional: sem ele fica o que o fecho já gravou (o
   * padrão do vencedor). Serve para quem quer receber em outro endereço.
   */
  @IsOptional()
  @IsString()
  addressId?: string;
}
