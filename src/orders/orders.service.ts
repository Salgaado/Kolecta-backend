import {
  Inject,
  Injectable,
  BadRequestException,
  BadGatewayException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WalletService } from '../wallet/wallet.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, inArray, and, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { CreateOrderDto, UpdateOrderStatusDto } from './dto/create-order.dto';
import { PagarmeService } from '../pagarme/pagarme.service';
import { buildSplit, PagarmeSplit } from '../pagarme/pagarme-split';
import { FounderService } from '../founder/founder.service';

/**
 * Taxa do gateway (Pagar.me) descontada do líquido do vendedor, em %.
 * PIX tem custo muito menor que cartão; o valor real depende do contrato da
 * conta. Default 0 (Kolecta absorve) até o número real ser confirmado — NÃO
 * chutamos um valor para não lesar o vendedor. Ver `PAGARME_GATEWAY_FEE_PERCENT`.
 * Substitui o antigo `~4%` hardcoded que era estimativa da Stripe (bug B4).
 */
const GATEWAY_FEE_PERCENT = parseFloat(
  process.env.PAGARME_GATEWAY_FEE_PERCENT ?? '0',
);

/**
 * Recebedor da plataforma (Kolecta) na Pagar.me — destino da comissão no split.
 * Sem ele configurado, o split é PULADO (fallback legado: a cobrança cai 100%
 * na conta principal e a divisão fica só no ledger da wallet). Ver
 * docs/PLAN-wallet-split.md (Fase 2).
 */
const PLATFORM_RECIPIENT_ID = process.env.PAGARME_PLATFORM_RECIPIENT_ID ?? '';

/** Validade do QR Code PIX da compra, em segundos (1h). */
const PIX_EXPIRES_IN_SECONDS = 3600;

/**
 * Taxa do gateway no CARTÃO, em %. Muito maior que o PIX; o vendedor absorve
 * (decisão do dono). Só bookkeeping no pedido — a taxa REAL a Pagar.me já
 * desconta via `charge_processing_fee:true`. Configurável via env.
 */
const CARD_FEE_PERCENT = parseFloat(
  process.env.PAGARME_CARD_FEE_PERCENT ?? '0',
);

/**
 * CET (Custo Efetivo Total) por nº de parcelas — contrato Pagar.me da Kolecta
 * ("Condições acordadas": taxa MDR + antecipação automática). Fração do valor da
 * transação que a Pagar.me retém no recebimento em ~30 dias. É a fonte da verdade
 * do parcelamento; se a Pagar.me renegociar as taxas, atualizar ESTA tabela.
 */
const PAGARME_CET_BY_INSTALLMENT: Readonly<Record<number, number>> = {
  1: 0.0399,
  2: 0.0654,
  3: 0.0802,
  4: 0.095,
  5: 0.1097,
  6: 0.1245,
  7: 0.1393,
  8: 0.1541,
  9: 0.1689,
  10: 0.1837,
  11: 0.1985,
  12: 0.2133,
};

/**
 * "Juros no comprador": ao parcelar, o comprador paga a MAIS o custo EXTRA de
 * parcelar vs. à vista (CET_n − CET_1x). O crédito à vista (1x) continua SEM
 * juros. O acréscimo cai no recebedor da plataforma no split para compensar a
 * antecipação cobrada pela Pagar.me — não é margem da Kolecta. Defina
 * PAGARME_INSTALLMENT_INTEREST=off para zerar (promoção "tudo sem juros").
 */
const INSTALLMENT_INTEREST_ENABLED =
  (process.env.PAGARME_INSTALLMENT_INTEREST ?? 'on').toLowerCase() !== 'off';

/**
 * Rede de segurança do envio, em dias a partir da POSTAGEM. Só entra em cena
 * quando o rastreio não acusou a entrega e o comprador nunca confirmou — sem
 * isso o saldo do vendedor ficaria retido indefinidamente. A entrega detectada
 * pelo Melhor Envio antecipa o prazo para entrega + 48h.
 */
const SHIPPING_FALLBACK_RELEASE_DAYS = parseInt(
  process.env.SHIPPING_FALLBACK_RELEASE_DAYS ?? '14',
  10,
);

/** Máximo de parcelas permitido no cartão. */
const MAX_INSTALLMENTS = 12;

/** Valor mínimo por parcela, em centavos (evita parcela irrisória). */
const MIN_INSTALLMENT_IN_CENTS = 500; // R$ 5,00

/**
 * Calcula o parcelamento de um principal pela tabela de CET acordada. O comprador
 * paga o principal + o acréscimo de parcelar (CET_n − CET_1x); as parcelas são
 * iguais, como a Pagar.me exibe. Retorna o valor de cada parcela, o total cobrado
 * (parcela × n) e o juro embutido, todos em centavos. 1x, juros desligado, ou nº
 * de parcelas fora da tabela → sem juro (total == principal).
 */
function computeInstallment(
  principalInCents: number,
  installments: number,
): { installmentInCents: number; totalInCents: number; interestInCents: number } {
  const n = Math.round(installments);
  const cetN = PAGARME_CET_BY_INSTALLMENT[n];
  const cet1 = PAGARME_CET_BY_INSTALLMENT[1];
  const surcharge =
    INSTALLMENT_INTEREST_ENABLED && cetN !== undefined
      ? Math.max(0, cetN - cet1)
      : 0;
  if (n <= 1 || surcharge <= 0) {
    return {
      installmentInCents: principalInCents,
      totalInCents: principalInCents,
      interestInCents: 0,
    };
  }
  // Acréscimo de parcelar sobre o principal, dividido em n parcelas iguais.
  const grossInCents = principalInCents * (1 + surcharge);
  const installmentInCents = Math.round(grossInCents / n);
  const totalInCents = installmentInCents * n;
  return {
    installmentInCents,
    totalInCents,
    interestInCents: totalInCents - principalInCents,
  };
}

/** Uma entrada de split do POST /orders da Pagar.me. */

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly walletService: WalletService,
    private readonly pagarme: PagarmeService,
    private readonly eventEmitter: EventEmitter2,
    private readonly founderService: FounderService,
  ) {}

  // ── Create orders (legacy — sem PaymentIntent) ─────────────────────────────

  /**
   * Persiste CPF e telefone do comprador (só dígitos) para reuso nas transações
   * Pagar.me. Dado sensível (LGPD): não é logado. No-op quando ausente.
   *
   * O telefone importa além do checkout: a Pagar.me exige telefone no
   * `customer` para autorizar cartão, e o lance cobra pelo `customer_id` — sem
   * guardar aqui, quem só comprou continuaria sem conseguir dar lance.
   */
  private async persistBuyerContact(
    buyerId: string,
    cpf?: string,
    phone?: string,
  ) {
    const patch: Record<string, unknown> = {};
    const cpfDigits = String(cpf ?? '').replace(/\D/g, '');
    if (cpfDigits) patch.cpf = cpfDigits;
    const phoneDigits = String(phone ?? '').replace(/\D/g, '');
    if (phoneDigits.length >= 10 && phoneDigits.length <= 11) {
      patch.phone = phoneDigits;
    }
    if (Object.keys(patch).length === 0) return;
    await this.db
      .update(schema.users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.users.id, buyerId));
  }

  async createOrders(buyerId: string, dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('O carrinho está vazio');
    }

    await this.persistBuyerContact(buyerId, dto.buyerCpf, dto.buyerPhone);

    const listingIds = dto.items.map((i) => i.listingId);

    const existingListings = await this.db
      .select()
      .from(schema.listings)
      .where(inArray(schema.listings.id, listingIds));

    if (existingListings.length !== listingIds.length) {
      throw new NotFoundException(
        'Um ou mais anúncios não foram encontrados no sistema',
      );
    }

    for (const listing of existingListings) {
      if (listing.status !== 'active') {
        throw new BadRequestException(
          `O anúncio ${listing.id} não está mais disponível para venda`,
        );
      }
      if (listing.sellerId === buyerId) {
        throw new ForbiddenException(
          `Você não pode comprar o seu próprio produto (${listing.id})`,
        );
      }
    }

    return await this.db.transaction(async (tx) => {
      const createdOrders = [];

      for (const listing of existingListings) {
        await tx
          .update(schema.listings)
          .set({ status: 'pending_payment' })
          .where(eq(schema.listings.id, listing.id));

        const price: number = listing.priceInCents ?? 0;

        const [newOrder] = await tx
          .insert(schema.orders)
          .values({
            buyerId,
            sellerId: listing.sellerId,
            listingId: listing.id,
            totalInCents: price,
            status: 'pending',
          })
          .returning();

        createdOrders.push(newOrder);
      }

      return createdOrders;
    });
  }

  // ── Checkout: pedido + pagamento (wallet + PIX Pagar.me) ────────────────────

  /**
   * Cria o pedido e resolve o pagamento:
   *  - 100% wallet  → debita e confirma na hora (síncrono, sem gateway).
   *  - wallet+PIX ou só PIX → gera cobrança PIX na Pagar.me e devolve o QR.
   *    A confirmação do pedido só acontece no webhook `order.paid`
   *    (→ evento `pagarme.order.paid` → `confirmOrderPayment`).
   *
   * Substitui o antigo fluxo Stripe (`paymentIntents.create`). O caso híbrido
   * mantém o comportamento atual de debitar a parcela da wallet já no checkout;
   * se o PIX falhar/expirar, o handler `pagarme.order.failed` estorna.
   */
  async createCheckout(buyerId: string, dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('O carrinho está vazio');
    }

    await this.persistBuyerContact(buyerId, dto.buyerCpf, dto.buyerPhone);

    // MVP: 1 item por chamada (uma cobrança por vendedor)
    const listingId = dto.items[0].listingId;

    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, listingId));

    if (!listing) {
      throw new NotFoundException('Anúncio não encontrado');
    }
    if (listing.status !== 'active') {
      throw new BadRequestException(
        'Este anúncio não está mais disponível para venda',
      );
    }
    if (listing.sellerId === buyerId) {
      throw new ForbiddenException(
        'Você não pode comprar o seu próprio produto',
      );
    }

    // Comprador paga item + frete. O FRETE VAI PARA A KOLECTA no split, junto
    // com a comissão: é ela que compra a etiqueta no Melhor Envio e manda o PDF
    // ao vendedor. Antes o frete ia 100% ao vendedor — com a emissão automática
    // isso fazia a Kolecta pagar o frete DUAS vezes (repassava e ainda comprava
    // a etiqueta). A comissão continua incidindo só sobre o item.
    // Retirada pessoal (pickup): sem frete, sem etiqueta; libera na hora ao confirmar.
    const deliveryMethod: 'shipping' | 'pickup' =
      dto.deliveryMethod === 'pickup' ? 'pickup' : 'shipping';
    const itemInCents: number = listing.priceInCents ?? 0;
    const shippingInCents: number =
      deliveryMethod === 'pickup' ? 0 : dto.shippingInCents ?? 0;
    const totalInCents: number = itemInCents + shippingInCents;
    let walletDeducted = 0;
    let chargeAmount = totalInCents;

    // ── Verificar saldo da wallet se solicitado ──
    // Cartão NÃO combina com saldo (compra híbrida no cartão fica fora do split
    // nativo). Decisão do dono: cartão sempre cobra o valor cheio. Guarda aqui
    // no back independentemente do que o cliente enviar.
    if (dto.useWalletBalance && dto.paymentMethod !== 'credit_card') {
      const wallet = await this.walletService.getOrCreateWallet(buyerId);
      walletDeducted = Math.min(wallet.balanceInCents, totalInCents);
      chargeAmount = totalInCents - walletDeducted;
    }

    const paymentMethod =
      chargeAmount <= 0 ? 'wallet' : walletDeducted > 0 ? 'hybrid' : 'external';

    // ── Instrumento da parte cobrada via gateway (só quando há chargeAmount) ──
    // Default 'pix' (compatível com o checkout atual). 'credit_card' exige token
    // (gerado no front) e nº de parcelas válido para o valor.
    let instrument: 'pix' | 'credit_card' | null = null;
    let installments = 1;
    if (chargeAmount > 0) {
      instrument = dto.paymentMethod === 'credit_card' ? 'credit_card' : 'pix';
      if (instrument === 'credit_card') {
        if (!dto.cardToken) {
          throw new BadRequestException(
            'Token do cartão ausente. Recarregue a página e tente novamente.',
          );
        }
        installments = Math.min(
          Math.max(dto.installments ?? 1, 1),
          MAX_INSTALLMENTS,
        );
        // Bloqueia parcela irrisória: cada parcela ≥ MIN_INSTALLMENT_IN_CENTS.
        const maxAllowed = Math.max(
          1,
          Math.floor(chargeAmount / MIN_INSTALLMENT_IN_CENTS),
        );
        if (installments > maxAllowed) {
          throw new BadRequestException(
            `Valor permite no máximo ${maxAllowed}x (parcela mínima de ` +
              `R$ ${(MIN_INSTALLMENT_IN_CENTS / 100).toFixed(2)}).`,
          );
        }
      }
    }

    // ── Gate B5: venda externa exige recebedor APTO do vendedor ──
    // Se há valor a cobrar via gateway (external/híbrido), o líquido precisa cair
    // no recebedor Pagar.me do vendedor via split. Sem recebedor `active`, não há
    // pra onde splitar → bloquear a venda antes de criar o pedido (evita saldo
    // órfão). Checado aqui pois nada foi mutado ainda.
    let sellerRecipientId: string | null = null;
    if (chargeAmount > 0) {
      const [sellerProfile] = await this.db
        .select({
          recipientId: schema.sellerProfiles.pagarmeRecipientId,
          canReceive: schema.sellerProfiles.canReceive,
        })
        .from(schema.sellerProfiles)
        .where(eq(schema.sellerProfiles.userId, listing.sellerId));

      if (!sellerProfile?.canReceive || !sellerProfile.recipientId) {
        throw new BadRequestException(
          'Este vendedor ainda não está apto a receber pagamentos. ' +
            'Tente novamente mais tarde.',
        );
      }
      sellerRecipientId = sellerProfile.recipientId;
    }

    // Transação atômica: bloqueia o listing + cria o pedido
    const order = await this.db.transaction(async (tx) => {
      await tx
        .update(schema.listings)
        .set({ status: 'pending_payment' })
        .where(eq(schema.listings.id, listing.id));

      const [newOrder] = await tx
        .insert(schema.orders)
        .values({
          buyerId,
          sellerId: listing.sellerId,
          listingId: listing.id,
          // Endereço de entrega do checkout — antes era descartado, deixando o
          // pedido sem destino e travando a geração da etiqueta.
          addressId: dto.addressId ?? null,
          totalInCents,
          shippingInCents,
          // Só faz sentido com envio: em retirada não há etiqueta.
          shippingServiceId:
            deliveryMethod === 'pickup' ? null : (dto.shippingServiceId ?? null),
          shippingServiceName:
            deliveryMethod === 'pickup'
              ? null
              : (dto.shippingServiceName ?? null),
          deliveryMethod,
          status: 'pending',
          walletAmountInCents: walletDeducted,
          externalAmountInCents: chargeAmount,
          paymentMethod,
          paymentInstrument: instrument,
          installments: instrument ? installments : null,
        })
        .returning();

      return newOrder;
    });

    // ── Caso 1: Saldo da wallet cobre 100% do valor ──
    if (chargeAmount <= 0) {
      const wallet = await this.walletService.getOrCreateWallet(buyerId);
      await this.walletService.debit(
        wallet.id,
        walletDeducted,
        `Compra #${order.id.slice(0, 8)} (saldo integral)`,
        order.id,
      );

      // Confirma o pedido imediatamente
      await this.confirmOrderPayment(order.id, `wallet-${wallet.id}`);

      this.logger.log(
        `Pedido ${order.id} pago 100% via wallet (${totalInCents / 100} BRL)`,
      );

      return {
        orderId: order.id,
        totalInCents,
        walletDeducted,
        paidViaWallet: true,
      };
    }

    // ── Caso 2: Deduz parcial da wallet + cobra restante via PIX ──
    if (walletDeducted > 0) {
      const wallet = await this.walletService.getOrCreateWallet(buyerId);
      await this.walletService.debit(
        wallet.id,
        walletDeducted,
        `Abatimento parcial - Compra #${order.id.slice(0, 8)}`,
        order.id,
      );
      this.logger.log(
        `Abatido ${walletDeducted / 100} BRL da wallet. Restante: ${chargeAmount / 100} BRL via PIX.`,
      );
    }

    // Dados do comprador para o customer da Pagar.me (nome/email/cpf)
    const [buyer] = await this.db
      .select({
        name: schema.users.name,
        email: schema.users.email,
        cpf: schema.users.cpf,
      })
      .from(schema.users)
      .where(eq(schema.users.id, buyerId));

    const cpfDigits = (dto.buyerCpf || buyer?.cpf || '').replace(/\D/g, '');
    if (!cpfDigits) {
      throw new BadRequestException(
        'CPF é obrigatório para gerar o pagamento via PIX.',
      );
    }

    // Telefone é exigido pela Pagar.me para PIX ("At least one customer phone
    // is required"). DDD (2 primeiros dígitos) + número (restante).
    const phoneDigits = (dto.buyerPhone || '').replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      throw new BadRequestException(
        'Telefone (com DDD) é obrigatório para gerar o pagamento via PIX.',
      );
    }
    const areaCode = phoneDigits.slice(0, 2);
    const phoneNumber = phoneDigits.slice(2);

    // Guarda para o customer da Pagar.me (usado no lance por cartão).
    await this.persistBuyerContact(buyerId, cpfDigits, phoneDigits);

    // ── Juros do parcelamento (só cartão parcelado; "juros no comprador") ──
    // O comprador paga `chargeAmount + juros`. O vendedor recebe o líquido sobre
    // o principal → o líquido NÃO muda com o nº de parcelas.
    const { interestInCents } =
      instrument === 'credit_card'
        ? computeInstallment(chargeAmount, installments)
        : { interestInCents: 0 };
    const amountCharged = chargeAmount + interestInCents;

    // ── Split nativo (Fase 2) ──
    // Só na cobrança PURA (sem parcela de wallet). Híbrido → Fase 3.
    // Sem recebedor da plataforma configurado, pula o split (fluxo legado).
    let split: PagarmeSplit[] | undefined;
    if (walletDeducted === 0 && sellerRecipientId && PLATFORM_RECIPIENT_ID) {
      const commissionPct = await this.founderService.resolveCommissionPercent(
        listing.sellerId,
      );
      // Comissão sobre o ITEM + o frete inteiro. Ex.: item R$ 100, frete
      // R$ 15,50, comissão 11% → comprador paga 115,50; vendedor fica com
      // 89,00 (100 − 11%) e a Kolecta com 26,50 (11,00 + 15,50), de onde sai a
      // etiqueta.
      const platformFeeInCents =
        Math.round((itemInCents * commissionPct) / 100) + shippingInCents;
      // Juros do comprador entram no recebedor da PLATAFORMA (compensa a
      // antecipação cobrada pela Pagar.me — não é margem). Seller amount fica
      // igual ao caso à vista: amountCharged - (platformFee + juros).
      split = buildSplit(
        sellerRecipientId,
        amountCharged,
        platformFeeInCents + interestInCents,
        PLATFORM_RECIPIENT_ID,
      );
      this.logger.log(
        `Split pedido ${order.id}: vendedor ${(chargeAmount - platformFeeInCents) / 100} / ` +
          `plataforma ${platformFeeInCents / 100} (comissão ${
            Math.round((itemInCents * commissionPct) / 100) / 100
          } + frete ${shippingInCents / 100}) ` +
          `+ juros ${interestInCents / 100} BRL ` +
          `(comissão ${commissionPct}%, ${instrument}${instrument === 'credit_card' ? ` ${installments}x` : ''})`,
      );
    } else if (walletDeducted === 0 && sellerRecipientId && !PLATFORM_RECIPIENT_ID) {
      this.logger.warn(
        `Split pulado (PAGARME_PLATFORM_RECIPIENT_ID ausente) — pedido ${order.id} no fluxo legado.`,
      );
    }

    // ── Endereço de cobrança (obrigatório no cartão) ──
    // Só busca no cartão: o PIX não pede, e é uma consulta a menos por compra.
    let billingAddress: {
      line_1: string;
      line_2?: string;
      zip_code: string;
      city: string;
      state: string;
      country: string;
    } | null = null;

    if (instrument === 'credit_card' && dto.addressId) {
      const [end] = await this.db
        .select()
        .from(schema.addresses)
        .where(eq(schema.addresses.id, dto.addressId));

      if (end) {
        billingAddress = {
          // A Pagar.me espera "número, rua, bairro" numa linha só.
          line_1: [end.number, end.street, end.neighborhood]
            .filter(Boolean)
            .join(', '),
          ...(end.complement ? { line_2: end.complement } : {}),
          zip_code: String(end.zip).replace(/\D/g, ''),
          city: end.city,
          state: end.state,
          country: (end.country || 'BR').toUpperCase(),
        };
      }
    }

    if (instrument === 'credit_card' && !billingAddress) {
      // Sem endereço a Pagar.me recusa a cobrança inteira. Falhar aqui, com
      // mensagem clara, é melhor que levar um `validation_error` do gateway.
      throw new BadRequestException(
        'Escolha um endereço de entrega para pagar com cartão.',
      );
    }

    // Bloco de pagamento conforme o instrumento.
    const paymentBlock =
      instrument === 'credit_card'
        ? {
            payment_method: 'credit_card',
            credit_card: {
              installments,
              statement_descriptor: 'KOLECTA',
              card_token: dto.cardToken,
              // Endereço de cobrança: a Pagar.me EXIGE no cartão e recusa a
              // cobrança inteira sem ele — `validation_error | billing |
              // "value" is required`. O token gerado no navegador não carrega
              // endereço (a tokenização manda só número/nome/validade/CVV),
              // então ele precisa vir daqui. Usamos o endereço de entrega
              // escolhido no checkout, que é o que o comprador acabou de
              // confirmar.
              ...(billingAddress ? { card: { billing_address: billingAddress } } : {}),
            },
            ...(split ? { split } : {}),
          }
        : {
            payment_method: 'pix',
            pix: { expires_in: PIX_EXPIRES_IN_SECONDS },
            ...(split ? { split } : {}),
          };

    // Cria a cobrança na Pagar.me para o valor restante (+ juros no cartão).
    const pagarmeOrder = await this.pagarme.post<PagarmeOrderResponse>(
      '/orders',
      {
        items: [
          {
            amount: amountCharged,
            description: `Compra Kolecta #${order.id.slice(0, 8)}`,
            quantity: 1,
            code: 'kolecta-order',
          },
        ],
        customer: {
          name: buyer?.name || 'Comprador Kolecta',
          email: buyer?.email,
          type: 'individual',
          document: cpfDigits,
          document_type: 'CPF',
          phones: {
            mobile_phone: {
              country_code: '55',
              area_code: areaCode,
              number: phoneNumber,
            },
          },
        },
        payments: [paymentBlock],
        metadata: {
          type: 'purchase',
          orderId: order.id,
          buyerId,
          sellerId: listing.sellerId,
          walletDeducted: String(walletDeducted),
        },
      },
      `order-${order.id}`, // Idempotency-Key estável por pedido
    );

    const charge = pagarmeOrder.charges?.[0];
    const tx = charge?.last_transaction;

    // Cancela o pedido, devolve o listing e estorna o abatimento parcial da
    // wallet. Usado quando a cobrança falha (PIX não gerado / cartão recusado).
    const rollbackCheckout = async (reason: string) => {
      await this.db.transaction(async (t: any) => {
        await t
          .update(schema.orders)
          .set({ status: 'cancelled' })
          .where(eq(schema.orders.id, order.id));
        await t
          .update(schema.listings)
          .set({ status: 'active' })
          .where(eq(schema.listings.id, listing.id));
      });
      if (walletDeducted > 0) {
        const wallet = await this.walletService.getOrCreateWallet(buyerId);
        await this.walletService.credit(
          wallet.id,
          walletDeducted,
          `Estorno - ${reason} (Compra #${order.id.slice(0, 8)})`,
          order.id,
        );
      }
    };

    // ── Cartão: cobrança SÍNCRONA (aprova/recusa na resposta) ──
    if (instrument === 'credit_card') {
      const paid =
        pagarmeOrder.status === 'paid' || charge?.status === 'paid';
      if (!paid) {
        const gw = tx?.gateway_response as
          | { errors?: Array<{ message?: string }> }
          | undefined;
        this.logger.warn(
          `Cartão recusado (order ${order.id} / pagarme ${pagarmeOrder.id}, ` +
            `status ${pagarmeOrder.status}/${charge?.status}): ${JSON.stringify(tx?.gateway_response ?? {})}`,
        );
        await rollbackCheckout('cartão recusado');
        throw new BadRequestException(
          gw?.errors?.[0]?.message ||
            'Cartão recusado. Verifique os dados ou tente outro cartão.',
        );
      }

      // Persiste ids + juros antes de confirmar (bookkeeping).
      await this.db
        .update(schema.orders)
        .set({
          pagarmeOrderId: pagarmeOrder.id,
          pagarmeChargeId: charge?.id ?? null,
          stripePaymentId: pagarmeOrder.id,
          interestInCents,
        })
        .where(eq(schema.orders.id, order.id));

      // Cartão autoriza na hora → confirma inline (não espera webhook; o
      // order.paid que vier depois é idempotente por causa do guard de status).
      await this.confirmOrderPayment(order.id, pagarmeOrder.id, {
        pagarmeChargeId: charge?.id,
      });

      this.logger.log(
        `💳 Compra no cartão confirmada: order ${order.id} / pagarme ${pagarmeOrder.id} / ` +
          `R$ ${(amountCharged / 100).toFixed(2)} em ${installments}x ` +
          `(juros R$ ${(interestInCents / 100).toFixed(2)}, wallet ${walletDeducted / 100})`,
      );

      return {
        orderId: order.id,
        pagarmeOrderId: pagarmeOrder.id,
        totalInCents,
        walletDeducted,
        chargeAmount,
        amountCharged,
        installments,
        interestInCents,
        paidViaCard: true,
        paidViaWallet: false,
      };
    }

    // ── PIX: cobrança ASSÍNCRONA (confirma via webhook order.paid) ──
    // A Pagar.me responde 200 mesmo quando a transação falha (status no corpo).
    if (!tx?.qr_code) {
      // Extrai o motivo da Pagar.me (gateway_response.errors[].message ou
      // .message) para logar E devolver ao cliente — sem isso, o 502 vira uma
      // mensagem genérica e o motivo real (recebedor, split, valor) fica oculto.
      const gw = tx?.gateway_response as
        | { message?: string; errors?: Array<{ message?: string }> }
        | undefined;
      const reason =
        gw?.errors?.map((e) => e?.message).filter(Boolean).join(' · ') ||
        gw?.message ||
        `status ${charge?.status ?? pagarmeOrder.status}`;
      this.logger.error(
        `Falha ao gerar PIX da compra (order ${order.id} / pagarme ${pagarmeOrder.id}, ` +
          `status ${pagarmeOrder.status}/${charge?.status}): ${JSON.stringify(tx?.gateway_response ?? {})}`,
      );
      await rollbackCheckout('falha ao gerar PIX');
      throw new BadGatewayException(
        `Não foi possível gerar o PIX: ${reason}. Tente novamente.`,
      );
    }

    // Persiste os ids da Pagar.me nas colunas dedicadas (Fase 1). Mantém
    // stripePaymentId como espelho legado até o cleanup (Fase 7).
    await this.db
      .update(schema.orders)
      .set({
        pagarmeOrderId: pagarmeOrder.id,
        pagarmeChargeId: charge?.id ?? null,
        stripePaymentId: pagarmeOrder.id,
      })
      .where(eq(schema.orders.id, order.id));

    this.logger.log(
      `PIX de compra criado: order ${order.id} / pagarme ${pagarmeOrder.id} / ` +
        `R$ ${(chargeAmount / 100).toFixed(2)} (wallet ${walletDeducted / 100})`,
    );

    return {
      orderId: order.id,
      pagarmeOrderId: pagarmeOrder.id,
      totalInCents,
      walletDeducted,
      chargeAmount,
      qrCode: tx.qr_code, // copia-e-cola
      qrCodeUrl: tx.qr_code_url, // imagem do QR
      expiresAt: tx.expires_at,
      paidViaWallet: false,
    };
  }

  // ── Simulação de parcelamento (front exibe as parcelas sem confiar no client) ──

  /**
   * Simula o parcelamento no cartão de um valor (em centavos) até MAX_INSTALLMENTS,
   * respeitando a parcela mínima. "Juros no comprador" pela tabela de CET acordada
   * (ver PAGARME_CET_BY_INSTALLMENT). O front consome isto para montar o seletor de
   * parcelas; o valor cobrado é sempre RECALCULADO no `createCheckout` (nunca confia
   * no client).
   */
  simulateInstallments(amountInCents: number) {
    if (!amountInCents || amountInCents <= 0) {
      throw new BadRequestException('Valor inválido para simulação.');
    }
    const maxAllowed = Math.min(
      MAX_INSTALLMENTS,
      Math.max(1, Math.floor(amountInCents / MIN_INSTALLMENT_IN_CENTS)),
    );
    const options = [];
    for (let n = 1; n <= maxAllowed; n++) {
      const { installmentInCents, totalInCents, interestInCents } =
        computeInstallment(amountInCents, n);
      options.push({
        installments: n,
        installmentInCents,
        totalInCents,
        interestInCents,
        hasInterest: interestInCents > 0,
      });
    }
    return { amountInCents, options };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  // Converte o campo `images` (JSON stringificado ou CSV legado) em array.
  private parseImages(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  async findBuyerOrders(buyerId: string) {
    const rows = await this.db
      .select({
        order: schema.orders,
        listingTitle: schema.listings.title,
        listingImages: schema.listings.images,
        listingPrice: schema.listings.priceInCents,
        counterpartName: schema.users.name,
      })
      .from(schema.orders)
      .leftJoin(schema.listings, eq(schema.orders.listingId, schema.listings.id))
      // Para o comprador, a contraparte é o vendedor
      .leftJoin(schema.users, eq(schema.orders.sellerId, schema.users.id))
      .where(eq(schema.orders.buyerId, buyerId));

    return rows.map((r) => ({
      ...r.order,
      listing: {
        title: r.listingTitle ?? 'Item indisponível',
        images: this.parseImages(r.listingImages),
        priceInCents: r.listingPrice ?? r.order.totalInCents,
      },
      seller: { id: r.order.sellerId, name: r.counterpartName ?? 'Vendedor' },
    }));
  }

  async findById(orderId: string, userId: string) {
    const buyerUser = alias(schema.users, 'buyer_user');
    const sellerUser = alias(schema.users, 'seller_user');

    const [row] = await this.db
      .select({
        order: schema.orders,
        listingTitle: schema.listings.title,
        listingImages: schema.listings.images,
        listingPrice: schema.listings.priceInCents,
        listingCondition: schema.listings.condition,
        buyerName: buyerUser.name,
        sellerName: sellerUser.name,
        address: schema.addresses,
      })
      .from(schema.orders)
      .leftJoin(
        schema.listings,
        eq(schema.orders.listingId, schema.listings.id),
      )
      .leftJoin(buyerUser, eq(schema.orders.buyerId, buyerUser.id))
      .leftJoin(sellerUser, eq(schema.orders.sellerId, sellerUser.id))
      .leftJoin(
        schema.addresses,
        eq(schema.orders.addressId, schema.addresses.id),
      )
      .where(eq(schema.orders.id, orderId));

    if (!row) throw new NotFoundException('Pedido não encontrado');

    const { order } = row;

    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException('Acesso negado a este pedido');
    }

    return {
      ...order,
      listing: {
        title: row.listingTitle ?? 'Item indisponível',
        images: this.parseImages(row.listingImages),
        priceInCents: row.listingPrice ?? order.totalInCents,
        condition: row.listingCondition ?? null,
      },
      buyer: { id: order.buyerId, name: row.buyerName ?? 'Comprador' },
      seller: { id: order.sellerId, name: row.sellerName ?? 'Vendedor' },
      address: row.address ?? null,
    };
  }

  async findSellerOrders(sellerId: string) {
    const rows = await this.db
      .select({
        order: schema.orders,
        listingTitle: schema.listings.title,
        listingImages: schema.listings.images,
        listingPrice: schema.listings.priceInCents,
        counterpartName: schema.users.name,
      })
      .from(schema.orders)
      .leftJoin(schema.listings, eq(schema.orders.listingId, schema.listings.id))
      // Para o vendedor, a contraparte é o comprador
      .leftJoin(schema.users, eq(schema.orders.buyerId, schema.users.id))
      .where(eq(schema.orders.sellerId, sellerId));

    return rows.map((r) => ({
      ...r.order,
      listing: {
        title: r.listingTitle ?? 'Item indisponível',
        images: this.parseImages(r.listingImages),
        priceInCents: r.listingPrice ?? r.order.totalInCents,
      },
      buyer: { id: r.order.buyerId, name: r.counterpartName ?? 'Comprador' },
    }));
  }

  async updateOrderStatus(
    sellerId: string,
    orderId: string,
    dto: UpdateOrderStatusDto,
  ) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) {
      throw new NotFoundException('Pedido não encontrado');
    }

    if (order.sellerId !== sellerId) {
      throw new ForbiddenException('Acesso negado para este pedido');
    }

    // ── Rede de segurança da postagem ──
    // Em pedido com frete, o vendedor não marca "entregue" (só a transportadora
    // ou o comprador). Se o rastreio falhar E o comprador nunca confirmar, o
    // dinheiro ficaria retido para sempre. Ao postar, agendamos um release de
    // último recurso; quando o rastreio do Melhor Envio acusar a entrega, o
    // prazo é ANTECIPADO para entrega + 48h.
    const agendaFallback =
      dto.status === 'shipped' &&
      order.status !== 'shipped' &&
      order.deliveryMethod !== 'pickup' &&
      !order.autoReleaseAt;

    const [updated] = await this.db
      .update(schema.orders)
      .set({
        status: dto.status,
        ...(dto.trackingCode && { trackingCode: dto.trackingCode }),
        ...(dto.deliveryMethod && { deliveryMethod: dto.deliveryMethod }),
        ...(agendaFallback && {
          autoReleaseAt: new Date(
            Date.now() + SHIPPING_FALLBACK_RELEASE_DAYS * 24 * 60 * 60 * 1000,
          ),
        }),
      })
      .where(eq(schema.orders.id, orderId))
      .returning();

    // Pedido postado → avisa o comprador com o rastreio. Só na TRANSIÇÃO para
    // 'shipped': reenviar o mesmo status (ex.: corrigir o código) não deve
    // disparar de novo — a idempotência do MailService cobre, mas evitamos o
    // trabalho à toa.
    if (dto.status === 'shipped' && order.status !== 'shipped') {
      this.eventEmitter.emit('order.shipped', {
        orderId,
        buyerId: updated.buyerId,
        listingId: updated.listingId,
        trackingCode: updated.trackingCode ?? null,
      });
    }

    return updated;
  }

  // ── Webhook Handlers (Pagar.me) ────────────────────────────────────────────

  /**
   * PIX de compra pago. Emitido pelo webhook unificado da Pagar.me quando
   * `order.paid` chega SEM `metadata.type === 'wallet_deposit'` (depósito é
   * tratado à parte). O `data` é o objeto de pedido da Pagar.me.
   */
  @OnEvent('pagarme.order.paid')
  async handlePagarmeOrderPaid(data: any) {
    const orderId = data?.metadata?.orderId;
    if (!orderId) {
      this.logger.warn(
        `Pagar.me order.paid (${data?.id}) sem orderId no metadata. Ignorando.`,
      );
      return;
    }

    this.logger.log(
      `Processando order.paid da Pagar.me: pedido ${orderId} (pagarme ${data?.id})`,
    );
    const charge = data?.charges?.[0];
    await this.confirmOrderPayment(orderId, data?.id ?? 'pagarme', {
      pagarmeChargeId: charge?.id,
    });
  }

  /**
   * PIX de compra falhou/expirou/cancelado. Estorna o abatimento parcial da
   * wallet (se houve) e devolve o anúncio para `active`. Idempotente.
   */
  @OnEvent('pagarme.order.failed')
  async handlePagarmeOrderFailed(data: any) {
    const orderId = data?.metadata?.orderId;
    if (!orderId) {
      this.logger.warn(
        `Pagar.me order.failed (${data?.id}) sem orderId no metadata. Ignorando.`,
      );
      return;
    }

    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) {
      this.logger.warn(`order.failed: pedido ${orderId} não encontrado.`);
      return;
    }

    await this.cancelPendingOrder(order, 'PIX não concluído');
  }

  /**
   * Cancela um pedido pendente de forma ATÔMICA e idempotente: transiciona
   * pending→cancelled só se ainda estiver pending (guard no WHERE, evita
   * cancelamento/estorno duplicado por concorrência entre webhook, cron e
   * cancelamento manual), reativa o anúncio e estorna a parcela de wallet.
   * Retorna true se ESTE chamador foi quem cancelou.
   */
  private async cancelPendingOrder(
    order: any,
    reason: string,
  ): Promise<boolean> {
    const cancelled = await this.db
      .update(schema.orders)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(schema.orders.id, order.id),
          eq(schema.orders.status, 'pending'),
        ),
      )
      .returning();

    if (cancelled.length === 0) {
      // Outro caminho (webhook/cron) já resolveu — nada a fazer.
      this.logger.warn(
        `Cancelamento ignorado: pedido ${order.id} não está mais 'pending'.`,
      );
      return false;
    }

    await this.db
      .update(schema.listings)
      .set({ status: 'active' })
      .where(eq(schema.listings.id, order.listingId));

    const walletRefund = order.walletAmountInCents ?? 0;
    if (walletRefund > 0) {
      const wallet = await this.walletService.getOrCreateWallet(order.buyerId);
      await this.walletService.credit(
        wallet.id,
        walletRefund,
        `Estorno - ${reason} (Compra #${order.id.slice(0, 8)})`,
        order.id,
      );
    }

    this.logger.warn(
      `↩️ Pedido ${order.id} cancelado (${reason}). ` +
        `Anúncio reativado; wallet estornada em ${walletRefund / 100} BRL.`,
    );
    return true;
  }

  /**
   * Reconcilia um pedido PIX pendente com a Pagar.me antes de cancelar:
   * consulta o pedido no gateway e, se estiver `paid` (webhook perdido),
   * CONFIRMA em vez de cancelar (não perde uma venda paga). Caso contrário,
   * cancela. Se a consulta falhar (rede), mantém o pedido intocado.
   */
  private async reconcilePendingPix(
    order: any,
    reason: string,
  ): Promise<'paid' | 'cancelled' | 'kept'> {
    // Sem cobrança externa criada (ex.: PIX nunca gerou) → cancela direto.
    if (!order.pagarmeOrderId) {
      return (await this.cancelPendingOrder(order, reason)) ? 'cancelled' : 'kept';
    }

    let pg: PagarmeOrderResponse | undefined;
    try {
      pg = await this.pagarme.get<PagarmeOrderResponse>(
        `/orders/${order.pagarmeOrderId}`,
      );
    } catch (e: any) {
      this.logger.warn(
        `Reconciliação do pedido ${order.id} adiada (falha ao consultar Pagar.me): ${e?.message}`,
      );
      return 'kept';
    }

    if (pg?.status === 'paid') {
      this.logger.log(
        `Reconciliação: pedido ${order.id} está PAGO na Pagar.me — confirmando (webhook perdido).`,
      );
      await this.confirmOrderPayment(order.id, pg.id, {
        pagarmeChargeId: pg.charges?.[0]?.id,
      });
      return 'paid';
    }

    return (await this.cancelPendingOrder(order, reason)) ? 'cancelled' : 'kept';
  }

  /**
   * Cancelamento MANUAL pelo comprador (só do próprio pedido, só enquanto
   * pendente). Reconcilia com a Pagar.me: se já foi pago, confirma e devolve o
   * pedido pago (não cancela). Libera o anúncio na hora quando cancela.
   */
  async cancelOrder(buyerId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.buyerId !== buyerId) {
      throw new ForbiddenException('Acesso negado a este pedido');
    }
    if (order.status !== 'pending') {
      throw new BadRequestException(
        'Apenas pedidos aguardando pagamento podem ser cancelados.',
      );
    }

    const outcome = await this.reconcilePendingPix(order, 'cancelado pelo comprador');
    if (outcome === 'paid') {
      throw new BadRequestException(
        'Seu pagamento já foi confirmado — o pedido não pode ser cancelado.',
      );
    }

    const [updated] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    return updated;
  }

  /**
   * Varredura (cron): cancela pedidos PIX pendentes cujo QR já expirou e que
   * não receberam o webhook de falha (cinto de segurança). Reconcilia cada um
   * com a Pagar.me antes (recupera pagos com webhook perdido). Janela de graça
   * após o `expires_in` do PIX para não competir com o webhook normal.
   */
  async sweepExpiredPendingPix(): Promise<{ checked: number; cancelled: number; recovered: number }> {
    const GRACE_SECONDS = 10 * 60; // 10 min além do expires_in do PIX
    const cutoff = new Date(
      Date.now() - (PIX_EXPIRES_IN_SECONDS + GRACE_SECONDS) * 1000,
    );

    const stale = await this.db
      .select()
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.status, 'pending'),
          eq(schema.orders.paymentInstrument, 'pix'),
          lt(schema.orders.createdAt, cutoff),
        ),
      );

    let cancelled = 0;
    let recovered = 0;
    for (const order of stale) {
      try {
        const outcome = await this.reconcilePendingPix(order, 'PIX expirado');
        if (outcome === 'cancelled') cancelled++;
        else if (outcome === 'paid') recovered++;
      } catch (e: any) {
        this.logger.error(
          `Falha ao varrer pedido pendente ${order.id}: ${e?.message}`,
        );
      }
    }
    return { checked: stale.length, cancelled, recovered };
  }

  /**
   * Chargeback recebido (Fase 4.5). Abre uma disputa de sistema no pedido — o
   * `ReleaseBalanceCron` então CONGELA o auto-release enquanto ela estiver
   * aberta. Idempotente: não duplica disputa aberta para o mesmo pedido.
   * O estorno/decisão de liability roda na resolução da disputa.
   */
  @OnEvent('pagarme.charge.chargedback')
  async handlePagarmeChargeback(data: any) {
    // O orderId pode vir em metadata do charge ou do order aninhado (best-effort).
    const orderId =
      data?.metadata?.orderId ??
      data?.order?.metadata?.orderId ??
      data?.charge?.order?.metadata?.orderId;

    if (!orderId) {
      this.logger.warn(
        `chargeback.received (${data?.id}) sem orderId no metadata. Ignorando.`,
      );
      return;
    }

    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    if (!order) {
      this.logger.warn(`chargeback: pedido ${orderId} não encontrado.`);
      return;
    }

    // Idempotência: já existe disputa aberta para o pedido?
    const [existing] = await this.db
      .select({ id: schema.disputes.id })
      .from(schema.disputes)
      .where(
        and(
          eq(schema.disputes.orderId, orderId),
          inArray(schema.disputes.status, ['open', 'under_review']),
        ),
      );
    if (existing) {
      this.logger.warn(
        `chargeback: pedido ${orderId} já tem disputa aberta (${existing.id}).`,
      );
      return;
    }

    await this.db.insert(schema.disputes).values({
      orderId,
      // Parte "prejudicada" = comprador cujo banco abriu o chargeback.
      reporterId: order.buyerId,
      reason: 'chargeback',
      description:
        'Disputa aberta automaticamente por chargeback recebido na Pagar.me. ' +
        'Release do saldo do vendedor congelado até a resolução.',
      status: 'open',
    });

    this.logger.warn(
      `⚠️ Chargeback no pedido ${orderId}: disputa de sistema aberta; release congelado.`,
    );
  }

  // ── Shared order confirmation logic ───────────────────────────────────────

  private async confirmOrderPayment(
    orderId: string,
    providerPaymentId: string,
    opts?: { pagarmeChargeId?: string },
  ) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) {
      this.logger.error(`Pedido ${orderId} não encontrado.`);
      return;
    }

    if (order.status !== 'pending') {
      this.logger.warn(
        `Pedido ${orderId} já processado. Status atual: ${order.status}`,
      );
      return;
    }

    // Calcular taxas conforme fluxo canônico.
    // Comissão efetiva resolve a taxa de fundador (9% por 6 meses) quando aplicável.
    const platformFeePercent = await this.founderService.resolveCommissionPercent(
      order.sellerId,
    );
    // O frete fica com a Kolecta (ela compra a etiqueta), então entra na parte
    // da plataforma junto com a comissão — que continua incidindo só sobre o
    // item. Espelha o split; se divergir, o vendedor vê um valor retido
    // diferente do que cai no recebedor dele.
    const shippingInCents = order.shippingInCents ?? 0;
    const itemInCents = order.totalInCents - shippingInCents;
    const platformFeeInCents =
      Math.round((itemInCents * platformFeePercent) / 100) + shippingInCents;
    // Taxa do gateway (Pagar.me): incide apenas sobre o valor pago externamente
    // (não sobre a parcela paga com saldo da wallet). Cartão custa mais que PIX —
    // usa a taxa do instrumento. Percentual configurável via env; default 0 até o
    // custo real do contrato ser confirmado (bug B4). Base = principal (sem juros).
    const externalInCents = order.externalAmountInCents ?? order.totalInCents;
    const feePercent =
      order.paymentInstrument === 'credit_card'
        ? CARD_FEE_PERCENT
        : GATEWAY_FEE_PERCENT;
    const gatewayFeeInCents = Math.round((externalInCents * feePercent) / 100);
    const sellerNetInCents = order.totalInCents - platformFeeInCents - gatewayFeeInCents;

    await this.db.transaction(async (tx: any) => {
      await tx
        .update(schema.orders)
        .set({
          status: 'paid',
          // stripePaymentId mantido como espelho legado do id do provedor.
          stripePaymentId: providerPaymentId,
          ...(opts?.pagarmeChargeId
            ? { pagarmeChargeId: opts.pagarmeChargeId }
            : {}),
          sellerNetInCents,
          platformFeeInCents,
          // Grava na coluna dedicada (Fase 1) + espelho legado stripeFeeInCents.
          // NOTA (ponta P-fee): com split nativo + charge_processing_fee no
          // vendedor, a taxa REAL é descontada pela Pagar.me; hoje usamos o
          // GATEWAY_FEE_PERCENT (env, default 0). Reconciliar com a fee real
          // exige a API de balance_operations (fora do webhook order.paid).
          gatewayFeeInCents,
          stripeFeeInCents: gatewayFeeInCents,
        })
        .where(eq(schema.orders.id, orderId));

      await tx
        .update(schema.listings)
        .set({ status: 'sold' })
        .where(eq(schema.listings.id, order.listingId));
    });

    // Creditar valor líquido como saldo retido (held_balance) para o vendedor
    const sellerWallet = await this.walletService.getOrCreateWallet(order.sellerId);
    await this.walletService.hold(
      sellerWallet.id,
      sellerNetInCents,
      `Venda #${order.id.slice(0, 8)} — saldo retido (líquido: ${(sellerNetInCents / 100).toFixed(2)} BRL)`,
      order.id,
    );

    this.logger.log(
      `✅ Pedido ${order.id} confirmado. Hold de ${sellerNetInCents / 100} BRL (bruto: ${order.totalInCents / 100}, taxa plataforma: ${platformFeeInCents / 100}, taxa gateway: ${gatewayFeeInCents / 100})`,
    );

    // Busca dados do comprador e listing para o evento
    const [buyer] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, order.buyerId));

    const [listing] = await this.db
      .select({ title: schema.listings.title })
      .from(schema.listings)
      .where(eq(schema.listings.id, order.listingId));

    this.eventEmitter.emit('order.paid', {
      orderId: order.id,
      sellerId: order.sellerId,
      buyerId: order.buyerId,
      buyerName: buyer?.name ?? null,
      buyerEmail: buyer?.email ?? '',
      listingTitle: listing?.title ?? 'Item Kolecta',
      totalInCents: order.totalInCents,
    });
  }

  // ── Vendedor marca como entregue (RETIRADA PESSOAL) ───────────────────────

  /**
   * Entrega em mãos: o vendedor declara que entregou, o comprador confirma que
   * recebeu, e a validação das duas partes libera o saldo na hora.
   *
   * Restrito a `pickup` DE PROPÓSITO. Em pedido com frete quem declara a entrega
   * é a transportadora, não o vendedor — senão ele inicia o relógio sozinho
   * (podia marcar "entregue" logo após o pagamento) e o dinheiro sai em 48h sem
   * o pacote ter saído do lugar. No envio, a entrega vem do rastreio do Melhor
   * Envio (`meDeliveredAt`), com o prazo de segurança da postagem como rede.
   */
  async markAsDelivered(sellerId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.sellerId !== sellerId) {
      throw new ForbiddenException('Acesso negado para este pedido');
    }
    if (order.deliveryMethod !== 'pickup') {
      throw new BadRequestException(
        'Só a retirada pessoal é marcada como entregue pelo vendedor. ' +
          'Em pedidos com frete, a entrega é confirmada pelo rastreio ou pelo comprador.',
      );
    }
    if (order.status !== 'shipped' && order.status !== 'paid') {
      throw new BadRequestException(
        `Pedido não pode ser marcado como entregue. Status atual: ${order.status}`,
      );
    }

    const now = new Date();
    const autoReleaseAt = new Date(now.getTime() + 48 * 60 * 60 * 1000); // +48 horas

    const [updated] = await this.db
      .update(schema.orders)
      .set({
        status: 'delivered',
        deliveredAt: now,
        autoReleaseAt,
      })
      .where(eq(schema.orders.id, orderId))
      .returning();

    this.logger.log(
      `📦 Pedido ${orderId} marcado como entregue. Auto-release em ${autoReleaseAt.toISOString()}`,
    );

    return updated;
  }

  // ── Comprador confirma recebimento → libera saldo do vendedor ─────────────

  async confirmDelivery(buyerId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.buyerId !== buyerId) {
      throw new ForbiddenException('Apenas o comprador pode confirmar recebimento');
    }
    if (order.status !== 'delivered' && order.status !== 'shipped') {
      throw new BadRequestException(
        `Pedido não pode ser confirmado. Status atual: ${order.status}`,
      );
    }

    const now = new Date();

    // ── Confirmação do comprador libera NA HORA ───────────────────────────────
    // Quem recebeu o item é a autoridade sobre a entrega: confirmou, o saldo vai
    // de retido → disponível na mesma hora, na retirada pessoal e no envio.
    // Disputa aberta ainda congela o release.
    //
    // Isto SUBSTITUI a decisão P5 de 21/07, que abria uma janela de 48h mesmo
    // com a confirmação. Os 48h passam a ser só a garantia de quem NÃO confirma:
    // dão ao vendedor a certeza de receber e ao comprador tempo de abrir disputa.
    {
      try {
        const openDisputes = await this.db
          .select({ id: schema.disputes.id })
          .from(schema.disputes)
          .where(
            and(
              eq(schema.disputes.orderId, order.id),
              inArray(schema.disputes.status, ['open', 'under_review']),
            ),
          );

        if (openDisputes.length === 0) {
          const sellerNetInCents = order.sellerNetInCents || order.totalInCents;
          const sellerWallet = await this.walletService.getOrCreateWallet(
            order.sellerId,
          );
          const rotulo =
            order.deliveryMethod === 'pickup'
              ? 'Retirada pessoal confirmada'
              : 'Recebimento confirmado';
          await this.walletService.release(
            sellerWallet.id,
            sellerNetInCents,
            `${rotulo} — Pedido #${order.id.slice(0, 8)}`,
            order.id,
          );

          const [completed] = await this.db
            .update(schema.orders)
            .set({
              status: 'completed',
              buyerConfirmedAt: now,
              completedAt: now,
            })
            .where(eq(schema.orders.id, orderId))
            .returning();

          this.logger.log(
            `✅ Pedido ${orderId} (${order.deliveryMethod}): comprador confirmou → ` +
              `saldo liberado NA HORA (${sellerNetInCents / 100} BRL) para seller ${order.sellerId}.`,
          );
          return completed;
        }

        this.logger.warn(
          `Pedido ${orderId} com disputa aberta — ` +
            `release imediato congelado; segue janela padrão.`,
        );
      } catch (err: any) {
        // Se o release falhar (ex.: hold ausente), não quebra a confirmação:
        // cai no fluxo padrão e o ReleaseBalanceCron tenta depois.
        this.logger.error(
          `Falha no release imediato do pedido ${orderId}: ${err.message}. Caindo para janela padrão.`,
        );
      }
    }

    // Chegou aqui = disputa aberta ou falha no release imediato. Mantém a janela
    // de 48h como caminho de recuperação: o ReleaseBalanceCron tenta de novo
    // quando o prazo vencer e não houver disputa.
    const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const autoReleaseAt =
      order.autoReleaseAt && order.autoReleaseAt < in48h
        ? order.autoReleaseAt
        : in48h;

    const [updated] = await this.db
      .update(schema.orders)
      .set({
        // 'delivered' faz o cron eleger o pedido para release quando vencer.
        status: 'delivered',
        buyerConfirmedAt: now,
        autoReleaseAt,
      })
      .where(eq(schema.orders.id, orderId))
      .returning();

    this.logger.log(
      `✅ Pedido ${orderId}: comprador confirmou recebimento. ` +
        `Release automático em ${autoReleaseAt.toISOString()} (janela 48h, salvo disputa).`,
    );

    return updated;
  }
}

// ── Tipagem mínima da resposta de /orders da Pagar.me (PIX) ───────────────────
interface PagarmeTransaction {
  qr_code?: string;
  qr_code_url?: string;
  expires_at?: string;
  status?: string;
  gateway_response?: unknown;
}

interface PagarmeCharge {
  id?: string;
  status?: string;
  last_transaction?: PagarmeTransaction;
}

interface PagarmeOrderResponse {
  id: string;
  status: string;
  charges?: PagarmeCharge[];
}

