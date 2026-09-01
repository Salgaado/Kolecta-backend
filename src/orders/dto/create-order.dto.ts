import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsCpf } from '../../common/validators/is-cpf.validator';

export class OrderItemDto {
  @IsString()
  @IsNotEmpty()
  listingId: string;

  // Quantas unidades. Opcional (default 1, compatível com clientes antigos).
  // O teto real é o estoque do anúncio, validado no service. Max 99 barra
  // pedido absurdo/erro de cliente antes de qualquer cobrança.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  quantity?: number;
}

/**
 * Endereço digitado no checkout por quem ainda não tem nenhum salvo.
 *
 * Existe porque o checkout precisa aceitar os DOIS caminhos — endereço salvo e
 * endereço novo. Antes o digitado era simplesmente descartado: o pedido nascia
 * sem destino, o `billing_address` do cartão não era montado (a Pagar.me recusa
 * com validation_error | billing) e a etiqueta ficava impossível.
 */
export class ShippingAddressDto {
  @IsString()
  @IsNotEmpty()
  recipientName: string;

  @IsString()
  @IsNotEmpty()
  street: string;

  @IsString()
  @IsNotEmpty()
  number: string;

  @IsOptional()
  @IsString()
  complement?: string;

  @IsOptional()
  @IsString()
  neighborhood?: string;

  @IsString()
  @IsNotEmpty()
  city: string;

  @IsString()
  @IsNotEmpty()
  state: string;

  @IsString()
  @IsNotEmpty()
  zip: string;

  @IsOptional()
  @IsString()
  country?: string;
}

export class CreateOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  @ArrayMinSize(1)
  items: OrderItemDto[];

  // Endereço JÁ salvo do comprador. Tem prioridade sobre `shippingAddress`.
  @IsString()
  @IsOptional()
  addressId?: string;

  // Endereço digitado agora. Usado quando o comprador não escolheu um salvo —
  // o backend cria a linha em `addresses` e usa o id resultante no pedido.
  @IsOptional()
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress?: ShippingAddressDto;

  // Frete escolhido pelo comprador, em centavos.
  //
  // É uma DECLARAÇÃO do cliente, não a fonte da verdade: desde o frete
  // compartilhado o servidor recota e usa o próprio valor (ver
  // `OrdersService.resolverFrete`). Este campo serve para conferir que o
  // comprador não vai ser cobrado mais do que apareceu na tela — se o servidor
  // cotar mais caro que isto, a compra é recusada em vez de cobrar a mais.
  //
  // O frete vai para a KOLECTA no split, não para o vendedor: é ela que compra
  // a etiqueta no Melhor Envio. A comissão continua incidindo só sobre o item.
  @IsInt()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  shippingInCents?: number;

  // Serviço do Melhor Envio escolhido pelo comprador (`raw.id` da cotação) e o
  // nome legível ("PAC", "SEDEX", "Jadlog .Package"). Sem isso só sabemos
  // QUANTO foi cobrado, não POR QUAL transportadora — e a etiqueta automática
  // sairia de um serviço diferente do que o comprador pagou.
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  shippingServiceId?: number;

  @IsString()
  @IsOptional()
  shippingServiceName?: string;

  // 'shipping' (envio) | 'pickup' (retirada pessoal). Em pickup não há frete e o
  // saldo libera na hora quando o comprador confirma o recebimento.
  @IsIn(['shipping', 'pickup'])
  @IsOptional()
  deliveryMethod?: 'shipping' | 'pickup';

  /**
   * @deprecated Sem efeito desde 31/07/2026 — pagar com saldo foi removido.
   *
   * A Pagar.me não faz transferência entre usuários: o saldo da carteira só sai
   * por saque. Abater a compra do saldo cobrava sem passar pelo split, então o
   * dinheiro caía inteiro na conta da Kolecta e a divisão existia só no nosso
   * ledger — a mesma falha que a Fase 1 fechou, por uma porta lateral.
   *
   * O campo continua aceito para não quebrar cliente antigo que ainda o envie;
   * o serviço ignora o valor.
   */
  @IsBoolean()
  @IsOptional()
  useWalletBalance?: boolean;

  // Instrumento da parte cobrada via gateway. Default 'pix' quando ausente
  // (compatibilidade com o checkout PIX atual).
  @IsIn(['pix', 'credit_card'])
  @IsOptional()
  paymentMethod?: 'pix' | 'credit_card';

  // Token do cartão gerado NO FRONT via chave pública Pagar.me (endpoint
  // /tokens). O número do cartão NUNCA passa pelo nosso backend (escopo PCI).
  // Obrigatório quando paymentMethod === 'credit_card'.
  @IsString()
  @IsOptional()
  cardToken?: string;

  // Nº de parcelas no cartão (1 = à vista, sem juros). Juros a partir de 2x
  // são custo do comprador. Limitado a 12x.
  @IsInt()
  @Min(1)
  @Max(12)
  @IsOptional()
  @Type(() => Number)
  installments?: number;

  // CPF do comprador (exigido pela Pagar.me na transação). Opcional por ora —
  // o fluxo 100% wallet ainda não obriga; o frontend passa a enviar no checkout.
  @IsCpf()
  @IsOptional()
  buyerCpf?: string;

  // Telefone do comprador (DDD + número, só dígitos). Exigido pela Pagar.me para
  // gerar o PIX ("At least one customer phone is required"). Opcional no DTO
  // porque o fluxo 100% wallet não gera cobrança externa.
  @IsString()
  @IsOptional()
  buyerPhone?: string;
}

export class UpdateOrderStatusDto {
  @IsString()
  @IsNotEmpty()
  status: string;

  @IsString()
  @IsOptional()
  trackingCode?: string;

  // 'shipping' (envio) | 'pickup' (retirada pessoal). Em pickup, a confirmação
  // do comprador libera o saldo na hora (sem a janela de 48h).
  @IsIn(['shipping', 'pickup'])
  @IsOptional()
  deliveryMethod?: 'shipping' | 'pickup';
}
