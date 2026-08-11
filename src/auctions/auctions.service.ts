import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import {
  eq,
  and,
  desc,
  lte,
  lt,
  ne,
  or,
  isNull,
  isNotNull,
  inArray,
  sql,
} from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { CARTAO_HABILITADO, LANCE_INDISPONIVEL } from '../common/payment-flags';
import { calcGatewayFeeInCents } from '../common/gateway-fees';
import { WalletService } from '../wallet/wallet.service';
import { FounderService } from '../founder/founder.service';
import { CardsService } from '../cards/cards.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { buildSplit, PagarmeSplit } from '../pagarme/pagarme-split';
import { ShippingService } from '../shipping/shipping.service';
import {
  CreateAuctionDto,
  PlaceBidDto,
  ChooseAuctionShippingDto,
} from './dto/auction.dto';

/**
 * Recebedor da plataforma na Pagar.me (destino da comissão no split do arremate).
 * Sem ele, a pré-auth do lance vai sem split (fallback legado). Ver orders.service.
 */
const PLATFORM_RECIPIENT_ID = process.env.PAGARME_PLATFORM_RECIPIENT_ID ?? '';

/**
 * Janela de validade estimada da pré-autorização (dias). A adquirente garante os
 * fundos por ~5 dias; o cron de re-auth (Fase 3) renova antes disso em leilões
 * mais longos. Configurável por `PAGARME_PREAUTH_VALIDITY_DAYS`.
 */
const AUTH_VALIDITY_DAYS = parseInt(
  process.env.PAGARME_PREAUTH_VALIDITY_DAYS ?? '5',
  10,
);

/**
 * Antecedência com que o cron de re-auth (Fase 3) renova uma pré-autorização
 * antes de ela expirar. Ex.: 24h → toda auth que vence nas próximas 24h é
 * renovada. Precisa ser < janela real da adquirente. Configurável por
 * `PAGARME_REAUTH_WINDOW_HOURS`.
 */
const REAUTH_WINDOW_HOURS = parseInt(
  process.env.PAGARME_REAUTH_WINDOW_HOURS ?? '24',
  10,
);

/**
 * Prazo (horas) que o vencedor de um leilão tem para pagar quando a captura da
 * pré-auth falha no fecho (pedido `pending_payment`). Expirado → o cron oferece
 * ao 2º colocado ou reabre o anúncio. Configurável por
 * `AUCTION_PAYMENT_DEADLINE_HOURS`.
 */
const PAYMENT_DEADLINE_HOURS = parseInt(
  process.env.AUCTION_PAYMENT_DEADLINE_HOURS ?? '24',
  10,
);

@Injectable()
export class AuctionsService {
  private readonly logger = new Logger(AuctionsService.name);

  /**
   * Monta o split do leilão — ou recusa a operação.
   *
   * Antes, faltar recebedor (do vendedor ou da plataforma) fazia a cobrança
   * seguir SEM split e sem sequer um log: o dinheiro caía inteiro na conta
   * principal e a divisão existia só no ledger. Mesma régua do fluxo de compra
   * (`orders.service.ts`), que já recusava a venda nessa situação.
   */
  private montarSplitOuRecusar(
    sellerRecipientId: string | null,
    amountInCents: number,
    platformFeeInCents: number,
  ): PagarmeSplit[] {
    if (!sellerRecipientId) {
      throw new BadRequestException(
        'Este vendedor ainda não está apto a receber pagamentos. ' +
          'Tente novamente mais tarde.',
      );
    }
    if (!PLATFORM_RECIPIENT_ID) {
      this.logger.error(
        'PAGARME_PLATFORM_RECIPIENT_ID ausente — operação de leilão recusada ' +
          'para não cobrar sem split. Configure o recebedor da plataforma.',
      );
      throw new ServiceUnavailableException(
        'Não foi possível processar o pagamento agora. Já estamos ' +
          'verificando — tente novamente em alguns minutos.',
      );
    }
    return buildSplit(
      sellerRecipientId,
      amountInCents,
      platformFeeInCents,
      PLATFORM_RECIPIENT_ID,
    );
  }

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly walletService: WalletService,
    private readonly founderService: FounderService,
    private readonly cardsService: CardsService,
    private readonly pagarme: PagarmeService,
    private readonly shipping: ShippingService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Nome de exibição do vendedor, na mesma régua da vitrine
   * (`listings.service.ts`): quem vende como loja cadastra o nome em
   * `seller_profiles.store_name`, e é ele que deve aparecer — cair em
   * `users.name` mostraria a parte local do e-mail de quem entrou sem loja.
   *
   * O leilão não trazia nome nenhum: o select tinha só `sellerId`, e a página
   * de lance chumbava "Vendedor Kolecta" no lugar. Duas lojas diferentes
   * apareciam com o mesmo nome, e o comprador não sabia de quem estava
   * comprando na hora de dar lance.
   */
  private readonly sellerDisplayName = sql<string | null>`COALESCE(
    NULLIF(TRIM(${schema.sellerProfiles.storeName}), ''),
    NULLIF(TRIM(${schema.users.name}), '')
  )`.as('seller_name');

  private readonly auctionListingSelect = {
    pausedAt: schema.auctions.pausedAt,
    id: schema.auctions.id,
    listingId: schema.auctions.listingId,
    startingBidInCents: schema.auctions.startingBidInCents,
    minIncrementInCents: schema.auctions.minIncrementInCents,
    currentBidInCents: schema.auctions.currentBidInCents,
    reservePriceInCents: schema.auctions.reservePriceInCents,
    currentWinnerId: schema.auctions.currentWinnerId,
    durationHours: schema.auctions.durationHours,
    endsAt: schema.auctions.endsAt,
    antiSniper: schema.auctions.antiSniper,
    status: schema.auctions.status,
    createdAt: schema.auctions.createdAt,
    updatedAt: schema.auctions.updatedAt,
    title: schema.listings.title,
    images: schema.listings.images,
    condition: schema.listings.condition,
    sellerId: schema.listings.sellerId,
    sellerName: this.sellerDisplayName,
  };

  // ── Listar leilões ativos (público) ─────────────────────────────────────

  async findAll() {
    return (
      this.db
        .select(this.auctionListingSelect)
        .from(schema.auctions)
        .innerJoin(
          schema.listings,
          eq(schema.auctions.listingId, schema.listings.id),
        )
        // Vendedor + loja: `leftJoin` porque quem ainda não abriu loja não tem
        // `seller_profiles` e não pode sumir da vitrine por causa disso.
        .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
        .leftJoin(
          schema.sellerProfiles,
          eq(schema.sellerProfiles.userId, schema.listings.sellerId),
        )
        // endsAt não-nulo = leilão já iniciado (o admin ativou o anúncio);
        // leilões "parados" (anúncio em draft) não aparecem publicamente.
        .where(
          and(
            eq(schema.auctions.status, 'active'),
            isNotNull(schema.auctions.endsAt),
          ),
        )
    );
  }

  // ── Detalhe de um leilão ─────────────────────────────────────────────────

  async findById(auctionId: string) {
    const [row] = await this.db
      .select(this.auctionListingSelect)
      .from(schema.auctions)
      .innerJoin(
        schema.listings,
        eq(schema.auctions.listingId, schema.listings.id),
      )
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .leftJoin(
        schema.sellerProfiles,
        eq(schema.sellerProfiles.userId, schema.listings.sellerId),
      )
      .where(eq(schema.auctions.id, auctionId));

    if (!row) throw new NotFoundException('Leilão não encontrado');
    return row;
  }

  // ── Leilões do seller (autenticado) ──────────────────────────────────────

  async findSellerAuctions(sellerId: string) {
    const rows = await this.db
      .select(this.auctionListingSelect)
      .from(schema.auctions)
      .innerJoin(
        schema.listings,
        eq(schema.auctions.listingId, schema.listings.id),
      )
      .leftJoin(schema.users, eq(schema.listings.sellerId, schema.users.id))
      .leftJoin(
        schema.sellerProfiles,
        eq(schema.sellerProfiles.userId, schema.listings.sellerId),
      )
      .where(eq(schema.listings.sellerId, sellerId))
      .orderBy(desc(schema.auctions.createdAt));

    if (rows.length === 0) return rows;

    // Enriquece com nº de lances por leilão e o NOME do vencedor (o painel do
    // vendedor mostrava "0 lances" e o vencedor como id cru — ver F26).
    const auctionIds = rows.map((r) => r.id);
    const counts = await this.db
      .select({
        auctionId: schema.bids.auctionId,
        total: sql<number>`count(*)`,
      })
      .from(schema.bids)
      .where(inArray(schema.bids.auctionId, auctionIds))
      .groupBy(schema.bids.auctionId);
    const countByAuction = new Map(
      counts.map((c) => [c.auctionId, Number(c.total)]),
    );

    const winnerIds = [
      ...new Set(rows.map((r) => r.currentWinnerId).filter(Boolean)),
    ] as string[];
    const nameByUser = new Map<string, string | null>();
    if (winnerIds.length > 0) {
      const winners = await this.db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(inArray(schema.users.id, winnerIds));
      winners.forEach((u) => nameByUser.set(u.id, u.name ?? null));
    }

    return rows.map((r) => ({
      ...r,
      totalBids: countByAuction.get(r.id) ?? 0,
      winnerName: r.currentWinnerId
        ? (nameByUser.get(r.currentWinnerId) ?? null)
        : null,
    }));
  }

  // ── Criar leilão (seller) ────────────────────────────────────────────────

  async create(sellerId: string, dto: CreateAuctionDto) {
    // Valida se o listing existe e pertence ao seller
    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(
        and(
          eq(schema.listings.id, dto.listingId),
          eq(schema.listings.sellerId, sellerId),
        ),
      );

    if (!listing) {
      throw new NotFoundException(
        'Anúncio não encontrado ou não pertence a você',
      );
    }

    if (listing.type !== 'auction') {
      throw new BadRequestException(
        'O anúncio precisa ser do tipo "auction" para criar um leilão',
      );
    }

    if (listing.status !== 'active') {
      throw new BadRequestException('O anúncio precisa estar ativo');
    }

    const durationHours = dto.durationHours ?? 48;
    const endsAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);

    const [auction] = await this.db
      .insert(schema.auctions)
      .values({
        listingId: dto.listingId,
        startingBidInCents: dto.startingBidInCents,
        minIncrementInCents: dto.minIncrementInCents ?? 1000,
        reservePriceInCents: dto.reservePriceInCents,
        durationHours,
        endsAt,
        antiSniper: dto.antiSniper ?? true,
        status: 'active',
      })
      .returning();

    return auction;
  }

  // ── Dar lance ────────────────────────────────────────────────────────────

  async placeBid(auctionId: string, bidderId: string, dto: PlaceBidDto) {
    const [auction] = await this.db
      .select()
      .from(schema.auctions)
      .where(eq(schema.auctions.id, auctionId));

    if (!auction) throw new NotFoundException('Leilão não encontrado');

    if (auction.status !== 'active') {
      throw new BadRequestException('Este leilão não está mais ativo');
    }

    if (auction.endsAt && auction.endsAt < new Date()) {
      throw new BadRequestException('Este leilão já encerrou');
    }

    // Verifica se o bidder é o próprio seller do listing
    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, auction.listingId));

    if (listing?.sellerId === bidderId) {
      throw new ForbiddenException(
        'Você não pode dar lances no seu próprio leilão',
      );
    }

    // Validação do valor do lance
    const currentBid = auction.currentBidInCents ?? auction.startingBidInCents;
    const minRequired = currentBid + (auction.minIncrementInCents ?? 1000);

    if (dto.amountInCents < minRequired) {
      throw new BadRequestException(
        `Lance mínimo: R$${(minRequired / 100).toFixed(2)}`,
      );
    }

    // ── Cartão salvo obrigatório (lance por cartão) ──
    // O lance é garantido por pré-autorização no cartão. Sem cartão salvo no
    // Financeiro, não há como reter o valor → bloqueia.
    const cardRef = await this.cardsService.getCardRef(bidderId);
    if (!cardRef) {
      throw new BadRequestException(
        'Salve um cartão de crédito no Financeiro para dar lances.',
      );
    }

    // Recebedor do vendedor (p/ split nativo no arremate). Ausente/inapto →
    // pré-auth sem split (fallback legado, igual ao checkout).
    const sellerRecipientId = await this._getSellerRecipientId(
      listing.sellerId,
    );

    // Vencedor anterior (será superado) + a auth dele (a ser cancelada se
    // ganharmos a corrida). Capturado ANTES de criar a nova auth.
    const prevWinnerId = auction.currentWinnerId;
    const prevAuth = prevWinnerId
      ? await this._getActiveBidAuth(auctionId, prevWinnerId)
      : null;

    // Endereço de cobrança de quem dá o lance: a Pagar.me exige no cartão.
    // Lance é garantido por pré-autorização no cartão — sem cartão, não há
    // lance. Fecha antes de qualquer escrita para não deixar leilão com estado
    // parcial.
    if (!CARTAO_HABILITADO) {
      throw new BadRequestException(LANCE_INDISPONIVEL);
    }
    if (auction.pausedAt) {
      throw new BadRequestException(
        'Este leilão está pausado no momento. Ele volta com o mesmo tempo que ' +
          'faltava — nenhum lance se perde.',
      );
    }

    const billingAddress = await this._getBillingAddress(bidderId);
    if (!billingAddress) {
      throw new BadRequestException(
        'Cadastre um endereço em Minha Conta para dar lances — a operadora ' +
          'exige endereço de cobrança para reter o valor no cartão.',
      );
    }

    // ── Pré-autorização (retenção) no cartão do bidder ──
    // Cria a auth ANTES de assumir a liderança; se perdermos a corrida de
    // concorrência abaixo, cancelamos a auth (rollback). Lança BadRequest com o
    // motivo da Pagar.me quando o cartão é recusado.
    const preAuth = await this._createBidPreAuth({
      customerId: cardRef.customerId,
      cardId: cardRef.cardId,
      amountInCents: dto.amountInCents,
      auctionId,
      bidderId,
      sellerId: listing.sellerId,
      sellerRecipientId,
      billingAddress,
    });

    let bid: typeof schema.bids.$inferSelect;
    try {
      bid = await this.db.transaction(async (tx: any) => {
        const [newBid] = await tx
          .insert(schema.bids)
          .values({
            auctionId,
            bidderId,
            amountInCents: dto.amountInCents,
            pagarmeOrderId: preAuth.orderId,
            pagarmeChargeId: preAuth.chargeId,
            pagarmeCardId: cardRef.cardId,
            authExpiresAt: preAuth.expiresAt,
          })
          .returning();

        // Anti-sniper: lance nos últimos 5 min estende o leilão em 5 min.
        let newEndsAt = auction.endsAt;
        if (
          auction.antiSniper &&
          auction.endsAt &&
          auction.endsAt.getTime() - Date.now() < 5 * 60 * 1000
        ) {
          newEndsAt = new Date(Date.now() + 5 * 60 * 1000);
          this.logger.log(
            `Anti-sniper ativado: leilão ${auctionId} estendido.`,
          );
        }

        // Guarda de concorrência: só vence quem supera o lance atual.
        const updated = await tx
          .update(schema.auctions)
          .set({
            currentBidInCents: dto.amountInCents,
            currentWinnerId: bidderId,
            endsAt: newEndsAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.auctions.id, auctionId),
              or(
                isNull(schema.auctions.currentBidInCents),
                lt(schema.auctions.currentBidInCents, dto.amountInCents),
              ),
            ),
          )
          .returning();

        if (updated.length === 0) {
          // Outro lance igual/maior chegou primeiro → desfaz o insert (rollback).
          throw new ConflictException(
            'Outro lance superou o seu. Atualize e tente novamente.',
          );
        }

        // Todos os outros lances ativos do leilão viram 'outbid' — sobra só o
        // novo (líder). Cobre o caso de o bidder subir o próprio lance.
        await tx
          .update(schema.bids)
          .set({ status: 'outbid' })
          .where(
            and(
              eq(schema.bids.auctionId, auctionId),
              eq(schema.bids.status, 'active'),
              ne(schema.bids.id, newBid.id),
            ),
          );

        return newBid;
      });
    } catch (err) {
      // Perdeu a corrida (ou erro) → cancela a retenção recém-criada.
      await this._voidPreAuth(preAuth.chargeId);
      throw err;
    }

    // Ganhou a liderança → cancela a auth do vencedor anterior (best-effort;
    // inclui o próprio bidder quando ele sobe o próprio lance).
    if (prevAuth?.chargeId) {
      await this._voidPreAuth(prevAuth.chargeId);
    }

    // Avisa o vendedor (lance novo) e quem foi superado. O listener resolve
    // e-mails e contagem. `prevWinnerId` só conta quando é OUTRA pessoa: subir
    // o próprio lance não é ser superado por ninguém.
    this.eventEmitter.emit('auction.bid.placed', {
      auctionId,
      listingId: auction.listingId,
      listingTitle: listing.title,
      sellerId: listing.sellerId,
      bidderId,
      amountInCents: dto.amountInCents,
      previousWinnerId:
        prevWinnerId && prevWinnerId !== bidderId ? prevWinnerId : null,
      previousBidInCents: auction.currentBidInCents ?? null,
      endsAt: auction.endsAt ?? null,
    });

    return bid;
  }

  // ── Helpers de pré-autorização no cartão ──────────────────────────────────

  /**
   * Endereço de cobrança de quem dá o lance, no formato da Pagar.me.
   * Usa o endereço padrão dele (ou o primeiro cadastrado). Sem isso a
   * pré-autorização é recusada com `validation_error | billing`.
   */
  private async _getBillingAddress(userId: string) {
    // Traz todos e escolhe o padrão em JS: uma consulta só, sem depender de
    // ordenação no SQL, e o usuário raramente tem mais que uns poucos.
    const enderecos = await this.db
      .select()
      .from(schema.addresses)
      .where(eq(schema.addresses.userId, userId));
    const end = enderecos.find((e) => e.isDefault) ?? enderecos[0];
    if (!end) return null;
    return {
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

  /**
   * Endereço de entrega do comprador no leilão.
   *
   * Compra direta escolhe o endereço no checkout; o leilão não tem checkout —
   * o lance é só o valor da peça. Sem `orders.addressId` a etiqueta do Melhor
   * Envio nem chega a ser pedida, então puxamos o endereço padrão do cadastro.
   * Todo bidder tem endereço: `placeBid` exige um para a retenção no cartão.
   */
  private async _getDefaultAddressId(userId: string): Promise<string | null> {
    const enderecos = await this.db
      .select({
        id: schema.addresses.id,
        isDefault: schema.addresses.isDefault,
      })
      .from(schema.addresses)
      .where(eq(schema.addresses.userId, userId));
    const end = enderecos.find((e) => e.isDefault) ?? enderecos[0];
    return end?.id ?? null;
  }

  /** Recebedor apto do vendedor (p/ split), ou null (→ auth sem split). */
  private async _getSellerRecipientId(
    sellerId: string,
  ): Promise<string | null> {
    const [profile] = await this.db
      .select({
        recipientId: schema.sellerProfiles.pagarmeRecipientId,
        canReceive: schema.sellerProfiles.canReceive,
      })
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, sellerId));
    return profile?.canReceive && profile.recipientId
      ? profile.recipientId
      : null;
  }

  /** Auth vigente (order/charge) do lance ativo de um usuário no leilão. */
  private async _getActiveBidAuth(
    auctionId: string,
    bidderId: string,
  ): Promise<{ chargeId: string | null; orderId: string | null } | null> {
    const [b] = await this.db
      .select({
        chargeId: schema.bids.pagarmeChargeId,
        orderId: schema.bids.pagarmeOrderId,
      })
      .from(schema.bids)
      .where(
        and(
          eq(schema.bids.auctionId, auctionId),
          eq(schema.bids.bidderId, bidderId),
          eq(schema.bids.status, 'active'),
        ),
      );
    return b ?? null;
  }

  /**
   * Cria uma pré-autorização (`capture:false`) no cartão salvo do bidder, no
   * valor do lance. Retorna { orderId, chargeId, expiresAt }. Lança
   * BadRequest com o motivo da Pagar.me quando o cartão é recusado.
   */
  private async _createBidPreAuth(params: {
    customerId: string;
    cardId: string;
    amountInCents: number;
    auctionId: string;
    bidderId: string;
    sellerId: string;
    sellerRecipientId: string | null;
    billingAddress: {
      line_1: string;
      line_2?: string;
      zip_code: string;
      city: string;
      state: string;
      country: string;
    } | null;
  }): Promise<{ orderId: string; chargeId: string; expiresAt: Date }> {
    // Split nativo no arremate (executado na captura). Sem recebedor apto ou
    // sem recebedor da plataforma, a operação é recusada — nunca autorizada
    // sem split.
    const commissionPct = await this.founderService.resolveCommissionPercent(
      params.sellerId,
    );
    const split = this.montarSplitOuRecusar(
      params.sellerRecipientId,
      params.amountInCents,
      Math.round((params.amountInCents * commissionPct) / 100),
    );

    let pagarmeOrder: any;
    try {
      pagarmeOrder = await this.pagarme.post(
        '/orders',
        {
          customer_id: params.customerId,
          items: [
            {
              amount: params.amountInCents,
              description: `Lance Kolecta — leilão ${params.auctionId.slice(0, 8)}`,
              quantity: 1,
              code: 'kolecta-bid',
            },
          ],
          payments: [
            {
              payment_method: 'credit_card',
              credit_card: {
                capture: false, // pré-autorização (retenção sem captura)
                statement_descriptor: 'KOLECTA',
                card_id: params.cardId,
                // Endereço de cobrança: a Pagar.me EXIGE no cartão e recusa a
                // cobrança inteira sem ele. Mesmo motivo do checkout (ver
                // `validation_error | billing`) — aqui vem do endereço padrão
                // de quem dá o lance.
                ...(params.billingAddress
                  ? { card: { billing_address: params.billingAddress } }
                  : {}),
                ...(split ? { split } : {}),
              },
            },
          ],
          metadata: {
            type: 'bid_preauth',
            auctionId: params.auctionId,
            bidderId: params.bidderId,
          },
        },
        // Idempotência por lance (valor + bidder + janela do segundo).
        `bid-preauth-${params.auctionId}-${params.bidderId}-${params.amountInCents}-${Math.floor(Date.now() / 1000)}`,
      );
    } catch (err: any) {
      // NÃO engolir o motivo: antes o catch trocava qualquer falha por "tente
      // outro cartão", e um erro de DOCUMENTO ou de endereço virava um problema
      // de cartão aos olhos de quem dava o lance — impossível de diagnosticar
      // sem abrir o log do servidor.
      const detalhe =
        err?.response?.pagarme?.errors?.[0]?.message ||
        err?.response?.errors?.[0]?.message ||
        err?.response?.message ||
        err?.message;
      this.logger.error(
        `Pré-autorização do lance falhou (leilão ${params.auctionId}, ` +
          `bidder ${params.bidderId}): ${JSON.stringify(err?.response ?? detalhe)}`,
      );
      throw new BadRequestException(
        detalhe
          ? `Não foi possível autorizar o valor no seu cartão: ${detalhe}`
          : 'Não foi possível autorizar o valor no seu cartão. Tente outro cartão.',
      );
    }

    const charge = pagarmeOrder?.charges?.[0];
    const authorized =
      pagarmeOrder?.status === 'pending' || // order com charge autorizada
      charge?.status === 'authorized_pending_capture';

    if (!charge?.id || !authorized) {
      const reason =
        charge?.last_transaction?.gateway_response?.errors?.[0]?.message ||
        charge?.last_transaction?.acquirer_message ||
        'Cartão recusado. Verifique os dados ou tente outro cartão.';
      // Cancela a order caso tenha sido criada em estado não-autorizado.
      if (charge?.id) await this._voidPreAuth(charge.id);
      throw new BadRequestException(reason);
    }

    const expiresAt = new Date(
      Date.now() + AUTH_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );
    return { orderId: pagarmeOrder.id, chargeId: charge.id, expiresAt };
  }

  /** Cancela (void) uma pré-autorização. Best-effort — não derruba o fluxo. */
  private async _voidPreAuth(chargeId: string): Promise<void> {
    try {
      await this.pagarme.delete(`/charges/${chargeId}`);
    } catch (err: any) {
      this.logger.warn(
        `Falha ao cancelar pré-auth ${chargeId} (ignorado): ${err?.message}`,
      );
    }
  }

  // Não existe mais captura de pré-auth aqui, e é de propósito.
  //
  // O fecho do leilão capturava a retenção no valor do lance. Com o frete
  // escolhido DEPOIS do fecho, o total cresce — e não se captura acima do valor
  // autorizado. Capturar o lance aqui obrigaria a uma segunda cobrança só do
  // frete. A pré-auth virou garantia: segura o cartão até o vencedor pagar o
  // total (`payAuctionOrder`, cobrança nova) ou até o prazo vencer
  // (`_expirePendingPayment`), e nos dois casos termina em `_voidPreAuth`.

  // ── Fase 3: re-autorização das pré-autorizações a expirar ────────────────

  /**
   * Renova as pré-autorizações prestes a expirar dos lances líderes de leilões
   * ainda ativos. A adquirente garante os fundos por ~5 dias; leilões mais
   * longos perderiam a garantia. Para cada líder cujo `authExpiresAt` cai na
   * janela ({@link REAUTH_WINDOW_HOURS}): cria uma pré-auth nova no cartão do
   * bidder, faz a troca atômica no lance e cancela a antiga.
   *
   * Falha na renovação (cartão sem saldo/recusado agora) → mantém a auth antiga
   * e segue: no fechamento a captura da auth vencida cai no ramo
   * `pending_payment` (Fase 4), que dá prazo ao vencedor. Degrada seguro.
   */
  /**
   * Devolve ao ar os leilões de um vendedor que acabou de ficar apto a receber.
   *
   * Os leilões foram pausados na migração para a conta nova (31/07/2026): sem
   * recebedor ativo, `montarSplitOuRecusar` recusa o lance, e leilão visível
   * onde ninguém consegue dar lance é pior que leilão fora do ar — o comprador
   * culpa a plataforma e o vendedor perde a venda sem saber por quê.
   *
   * Cada um volta com o tempo que FALTAVA, não com o resto de um relógio que
   * continuou correndo no escuro: é o mesmo contrato de `scripts/pausar-leiloes.ts`.
   *
   * Idempotente: só toca em leilão pausado. Evento repetido não faz nada.
   */
  @OnEvent('seller.apto-a-receber')
  async retomarLeiloesDoVendedor(evento: {
    sellerId: string;
  }): Promise<number> {
    const pausados = await this.db
      .select({
        id: schema.auctions.id,
        restanteMs: schema.auctions.pausedRemainingMs,
      })
      .from(schema.auctions)
      .innerJoin(
        schema.listings,
        eq(schema.listings.id, schema.auctions.listingId),
      )
      .where(
        and(
          eq(schema.listings.sellerId, evento.sellerId),
          eq(schema.auctions.status, 'active'),
          isNotNull(schema.auctions.pausedAt),
        ),
      );

    if (pausados.length === 0) return 0;

    const agora = Date.now();
    for (const leilao of pausados) {
      await this.db
        .update(schema.auctions)
        .set({
          endsAt: new Date(agora + Math.max(0, leilao.restanteMs ?? 0)),
          pausedAt: null,
          pausedRemainingMs: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.auctions.id, leilao.id));
    }

    this.logger.log(
      `Vendedor ${evento.sellerId} apto a receber: ${pausados.length} leilão(ões) retomado(s).`,
    );
    return pausados.length;
  }

  async reauthorizeExpiringBids(): Promise<{
    reauthorized: string[];
    failed: string[];
  }> {
    const threshold = new Date(
      Date.now() + REAUTH_WINDOW_HOURS * 60 * 60 * 1000,
    );
    // Todos os líderes com retenção — não só os que vencem na janela. O filtro
    // por data ficou para depois, porque agora existe um segundo motivo para
    // renovar (ver abaixo) que a data não enxerga.
    const rows = await this.db
      .select({
        bidId: schema.bids.id,
        auctionId: schema.bids.auctionId,
        bidderId: schema.bids.bidderId,
        amountInCents: schema.bids.amountInCents,
        chargeId: schema.bids.pagarmeChargeId,
        authExpiresAt: schema.bids.authExpiresAt,
        sellerId: schema.listings.sellerId,
      })
      .from(schema.bids)
      .innerJoin(schema.auctions, eq(schema.bids.auctionId, schema.auctions.id))
      .innerJoin(
        schema.listings,
        eq(schema.auctions.listingId, schema.listings.id),
      )
      .where(
        and(
          eq(schema.bids.status, 'active'),
          eq(schema.auctions.status, 'active'),
          isNotNull(schema.bids.pagarmeChargeId),
          isNotNull(schema.bids.authExpiresAt),
        ),
      );

    const reauthorized: string[] = [];
    const failed: string[] = [];
    for (const row of rows) {
      let motivo: string | null =
        row.authExpiresAt && row.authExpiresAt <= threshold
          ? 'vence dentro da janela'
          : null;

      // A data de validade é ESTIMATIVA nossa (`AUTH_VALIDITY_DAYS`), não um
      // fato: bandeira e banco emissor às vezes devolvem o saldo antes do prazo
      // contratado, sem avisar ninguém. Confiar só na data deixa a plataforma
      // achando que tem garantia por dias — e descobrindo o contrário na hora
      // de capturar, com o leilão já fechado. Por isso, quem ainda não está na
      // janela tem a retenção CONFERIDA de verdade.
      if (!motivo) {
        const retida = await this._preAuthAindaRetida(row.chargeId!);
        if (retida === false) motivo = 'retenção não existe mais no cartão';
      }

      if (!motivo) continue;

      try {
        if (await this._reauthorizeBid(row)) {
          reauthorized.push(row.bidId);
          this.logger.log(`Re-auth do lance ${row.bidId}: ${motivo}.`);
        }
      } catch (err: any) {
        failed.push(row.bidId);
        this.logger.error(
          `Re-auth do lance ${row.bidId} falhou (mantém a auth antiga): ${err?.message}`,
        );
      }
    }
    return { reauthorized, failed };
  }

  /**
   * A retenção ainda está de pé no cartão?
   *
   * `true` retida · `false` sumiu (liberada, cancelada, expirada) ·
   * **`null` não deu para saber** — erro de rede ou do gateway.
   *
   * O `null` é tratado como "retida" por quem chama, e isso é deliberado:
   * renovar sem necessidade cria uma SEGUNDA retenção no limite do comprador
   * enquanto a primeira ainda existe. Numa instabilidade do gateway, tratar
   * dúvida como ausência bloquearia o limite de todos os líderes de uma vez.
   */
  private async _preAuthAindaRetida(chargeId: string): Promise<boolean | null> {
    try {
      const charge: any = await this.pagarme.get(`/charges/${chargeId}`);
      // O sinal fica em `last_transaction.status`, não em `charge.status`: a
      // cobrança pré-autorizada aparece como `pending`, e é a transação que
      // diz `authorized_pending_capture`. Confirmado no ensaio de 31/07.
      const status =
        charge?.last_transaction?.status ?? charge?.status ?? 'desconhecido';
      return status === 'authorized_pending_capture';
    } catch (err: any) {
      this.logger.warn(
        `Não foi possível conferir a retenção da cobrança ${chargeId} (${err?.message}). Assumindo que segue de pé.`,
      );
      return null;
    }
  }

  /** Renova a pré-auth de um lance líder. Retorna true se trocou a auth. */
  private async _reauthorizeBid(row: {
    bidId: string;
    auctionId: string;
    bidderId: string;
    amountInCents: number;
    chargeId: string | null;
    sellerId: string;
  }): Promise<boolean> {
    // Renova no cartão ATUAL do bidder (1 por usuário). Sem cartão salvo (removido
    // depois do lance) → não há como renovar; mantém a auth antiga.
    const cardRef = await this.cardsService.getCardRef(row.bidderId);
    if (!cardRef) {
      this.logger.warn(
        `Re-auth do lance ${row.bidId}: bidder ${row.bidderId} sem cartão salvo. Mantém a auth antiga.`,
      );
      return false;
    }

    const sellerRecipientId = await this._getSellerRecipientId(row.sellerId);

    // Nova pré-auth no valor do lance (lança se o cartão recusar).
    const fresh = await this._createBidPreAuth({
      customerId: cardRef.customerId,
      cardId: cardRef.cardId,
      amountInCents: row.amountInCents,
      auctionId: row.auctionId,
      bidderId: row.bidderId,
      sellerId: row.sellerId,
      sellerRecipientId,
      billingAddress: await this._getBillingAddress(row.bidderId),
    });

    // Troca atômica: só aponta o lance para a auth nova se ele AINDA é o líder
    // com a MESMA auth antiga (evita corrida com um lance que o superou/fechou).
    const swapped = await this.db
      .update(schema.bids)
      .set({
        pagarmeOrderId: fresh.orderId,
        pagarmeChargeId: fresh.chargeId,
        pagarmeCardId: cardRef.cardId,
        authExpiresAt: fresh.expiresAt,
      })
      .where(
        and(
          eq(schema.bids.id, row.bidId),
          eq(schema.bids.status, 'active'),
          eq(schema.bids.pagarmeChargeId, row.chargeId!),
        ),
      )
      .returning();

    if (swapped.length === 0) {
      // O lance mudou no meio da renovação → desfaz a auth nova (rollback).
      await this._voidPreAuth(fresh.chargeId);
      return false;
    }

    // Trocou → cancela a auth antiga (best-effort).
    await this._voidPreAuth(row.chargeId!);
    this.logger.log(
      `Re-auth do lance ${row.bidId}: nova pré-auth ${fresh.chargeId}; antiga ${row.chargeId} cancelada.`,
    );
    return true;
  }

  // ── Fase 4: pagamento do arremate pendente + expiração do prazo ──────────

  // ── Frete do arremate (escolhido pelo vencedor, depois do fecho) ─────────

  /**
   * Carrega um pedido de arremate que ainda está esperando o vencedor agir, já
   * validando dono, status e prazo. Compartilhado pela cotação, pela escolha do
   * frete e pelo pagamento — as três só fazem sentido na mesma janela.
   */
  private async _loadPendingAuctionOrder(
    buyerId: string,
    orderId: string,
  ): Promise<typeof schema.orders.$inferSelect> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) throw new NotFoundException('Pedido não encontrado');
    if (order.buyerId !== buyerId) {
      throw new ForbiddenException('Acesso negado a este pedido');
    }
    if (order.status !== 'pending_payment') {
      throw new BadRequestException(
        'Este pedido não está aguardando pagamento.',
      );
    }
    if (order.paymentDeadlineAt && order.paymentDeadlineAt < new Date()) {
      throw new BadRequestException(
        'O prazo para pagamento expirou. O item pode ter sido oferecido a outro participante.',
      );
    }
    return order;
  }

  /** Valor do lance, separado do frete já escolhido (se houve escolha). */
  private _bidPartOf(order: typeof schema.orders.$inferSelect): number {
    return order.totalInCents - (order.shippingInCents ?? 0);
  }

  /**
   * Opções de entrega para o VENCEDOR de um leilão escolher.
   *
   * Cota com o endereço de entrega do pedido (o padrão do vencedor, gravado no
   * fecho) contra a origem do vendedor, e devolve junto o valor do lance para o
   * front conseguir mostrar o total de cada opção sem fazer conta própria.
   */
  async getAuctionShippingOptions(buyerId: string, orderId: string) {
    const order = await this._loadPendingAuctionOrder(buyerId, orderId);
    const bidInCents = this._bidPartOf(order);

    const endereco = order.addressId
      ? await this.db.query.addresses.findFirst({
          where: eq(schema.addresses.id, order.addressId),
        })
      : null;

    // Sem endereço não há o que cotar. Não é erro: o vencedor cadastra um e
    // volta, e o front precisa saber disso para mandá-lo ao lugar certo.
    if (!endereco) {
      return {
        bidInCents,
        address: null,
        needsAddress: true,
        pickup: false,
        options: [] as any[],
      };
    }

    const cotacao = await this.shipping.quoteShipping({
      to_cep: String(endereco.zip),
      listing_id: order.listingId ?? undefined,
    } as any);

    // Só o que dá para cobrar de verdade. Opção sem `raw.id` é o mock que o
    // ShippingService devolve quando o Melhor Envio não responde — mostrar
    // aquilo aqui viraria cobrança de um preço que não corresponde a serviço
    // nenhum, e a etiqueta sairia por outro valor.
    const options = (cotacao?.options ?? [])
      .filter((o: any) => o?.raw?.id && Number.isFinite(o.price))
      .map((o: any) => {
        const shippingInCents = Math.round(o.price * 100);
        return {
          serviceId: Number(o.raw.id),
          carrier: o.carrier,
          service: o.service,
          name: `${o.carrier} ${o.service}`,
          shippingInCents,
          deliveryTimeDays: o.delivery_time_days ?? null,
          totalInCents: bidInCents + shippingInCents,
        };
      })
      .sort((a: any, b: any) => a.shippingInCents - b.shippingInCents);

    return {
      bidInCents,
      address: {
        id: endereco.id,
        city: endereco.city,
        state: endereco.state,
        zip: endereco.zip,
      },
      needsAddress: false,
      pickup: !!cotacao?.pickup,
      options,
    };
  }

  /**
   * O vencedor escolhe como receber, e o frete entra no total do arremate.
   *
   * O PREÇO é sempre o do servidor: recotamos aqui e casamos pelo id do
   * serviço. O corpo do request não carrega valor — se carregasse, o comprador
   * escolheria quanto paga de frete.
   *
   * Idempotente: escolher de novo recalcula a partir do lance (`_bidPartOf`),
   * então trocar SEDEX por PAC não acumula frete em cima de frete.
   */
  async chooseShipping(
    buyerId: string,
    orderId: string,
    dto: ChooseAuctionShippingDto,
  ) {
    const order = await this._loadPendingAuctionOrder(buyerId, orderId);
    const bidInCents = this._bidPartOf(order);
    // Comissão travada no fecho do leilão (a taxa de fundador pode mudar entre
    // o fecho e a escolha; quem arrematou merece a que valia na hora).
    const comissaoInCents =
      (order.platformFeeInCents ?? 0) - (order.shippingInCents ?? 0);

    // Endereço: o do corpo tem prioridade, e precisa ser do próprio comprador.
    let addressId = order.addressId;
    if (dto.addressId) {
      const escolhido = await this.db.query.addresses.findFirst({
        where: eq(schema.addresses.id, dto.addressId),
      });
      if (!escolhido || escolhido.userId !== buyerId) {
        throw new BadRequestException(
          'Endereço de entrega inválido ou de outro usuário.',
        );
      }
      addressId = escolhido.id;
    }

    let shippingInCents = 0;
    let shippingServiceId: number | null = null;
    let shippingServiceName: string | null = null;

    if (dto.deliveryMethod === 'pickup') {
      // Mesma regra do checkout de venda direta: o vendedor pode ter desligado
      // a entrega em mãos, e isso se confere no SERVIDOR.
      const [sellerProfile] = await this.db
        .select({ acceptsPickup: schema.sellerProfiles.acceptsPickup })
        .from(schema.sellerProfiles)
        .where(eq(schema.sellerProfiles.userId, order.sellerId));
      if (sellerProfile?.acceptsPickup === false) {
        throw new BadRequestException(
          'Este vendedor não faz entrega em mãos. Escolha uma opção de frete.',
        );
      }
    } else {
      if (!dto.shippingServiceId) {
        throw new BadRequestException(
          'Escolha uma opção de frete para continuar.',
        );
      }
      if (!addressId) {
        throw new BadRequestException(
          'Cadastre um endereço de entrega antes de escolher o frete.',
        );
      }
      const endereco = await this.db.query.addresses.findFirst({
        where: eq(schema.addresses.id, addressId),
      });
      if (!endereco) {
        throw new BadRequestException('Endereço de entrega não encontrado.');
      }

      const cotacao = await this.shipping.quoteShipping({
        to_cep: String(endereco.zip),
        listing_id: order.listingId ?? undefined,
      } as any);

      const escolhida = (cotacao?.options ?? []).find(
        (o: any) =>
          o?.raw?.id &&
          Number(o.raw.id) === Number(dto.shippingServiceId) &&
          Number.isFinite(o.price),
      );
      if (!escolhida) {
        throw new BadRequestException(
          'Esta opção de frete não está mais disponível para o seu endereço. ' +
            'Atualize a página e escolha de novo.',
        );
      }

      shippingInCents = Math.round(escolhida.price * 100);
      shippingServiceId = Number(escolhida.raw.id);
      shippingServiceName = `${escolhida.carrier} ${escolhida.service}`;
    }

    // O frete vai INTEIRO para a Kolecta, que compra a etiqueta — mesma regra
    // da venda direta (`orders.service.ts`). A comissão continua incidindo só
    // sobre o item. O líquido do vendedor, portanto, não muda com o frete.
    const totalInCents = bidInCents + shippingInCents;
    const platformFeeInCents = comissaoInCents + shippingInCents;

    const gravado = await this.db
      .update(schema.orders)
      .set({
        addressId,
        deliveryMethod: dto.deliveryMethod,
        shippingInCents,
        shippingServiceId,
        shippingServiceName,
        totalInCents,
        externalAmountInCents: totalInCents,
        platformFeeInCents,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.orders.id, order.id),
          // Guarda contra corrida com a expiração do prazo: se o cron cancelou
          // no meio, a escolha não ressuscita o pedido.
          eq(schema.orders.status, 'pending_payment'),
        ),
      )
      .returning();

    // Zero linhas = o cron cancelou entre a leitura e a escrita. Devolver
    // sucesso aqui faria o front seguir direto para a cobrança de um pedido que
    // não existe mais, e o erro apareceria como "cartão recusado".
    if (gravado.length === 0) {
      throw new BadRequestException(
        'O prazo deste arremate venceu enquanto você escolhia. O item pode ter sido oferecido a outro participante.',
      );
    }

    this.logger.log(
      `Arremate ${order.id}: entrega ${dto.deliveryMethod}` +
        (shippingServiceName ? ` (${shippingServiceName})` : '') +
        ` — lance R$${(bidInCents / 100).toFixed(2)} + frete ` +
        `R$${(shippingInCents / 100).toFixed(2)} = R$${(totalInCents / 100).toFixed(2)}.`,
    );

    return {
      orderId: order.id,
      deliveryMethod: dto.deliveryMethod,
      bidInCents,
      shippingInCents,
      shippingServiceName,
      totalInCents,
    };
  }

  /**
   * Vencedor paga o arremate (pedido `pending_payment`) via cartão salvo,
   * dentro do prazo. Cobrança à vista com captura imediata (não é pré-auth) e
   * split nativo, no total já com frete. Aprovado → pedido `paid`, anúncio
   * `sold`, líquido retido na wallet do vendedor e pré-auth do lance liberada.
   * Recusado → BadRequest (o pedido segue `pending_payment` até o prazo, e a
   * pré-auth continua de pé como garantia).
   */
  async payAuctionOrder(buyerId: string, orderId: string) {
    const order = await this._loadPendingAuctionOrder(buyerId, orderId);

    // Sem escolha de entrega não há total fechado — cobrar aqui cobraria só o
    // lance e deixaria a Kolecta pagando a etiqueta, que é exatamente o buraco
    // que este fluxo fecha. `deliveryMethod` só vira 'pickup' por escolha
    // explícita, e no envio o serviço fica gravado; um dos dois basta.
    const escolheuEntrega =
      order.deliveryMethod === 'pickup' || !!order.shippingServiceId;
    if (!escolheuEntrega) {
      throw new BadRequestException(
        'Escolha como quer receber o item (frete ou retirada) antes de pagar.',
      );
    }

    const cardRef = await this.cardsService.getCardRef(buyerId);
    if (!cardRef) {
      throw new BadRequestException(
        'Salve um cartão de crédito no Financeiro para pagar.',
      );
    }

    const sellerRecipientId = await this._getSellerRecipientId(order.sellerId);
    const totalInCents = order.totalInCents;

    // Split nativo (mesma regra do arremate): sem recebedor, recusa.
    const platformFeeInCents =
      order.platformFeeInCents ??
      Math.round(
        (totalInCents *
          (await this.founderService.resolveCommissionPercent(
            order.sellerId,
          ))) /
          100,
      );
    const split = this.montarSplitOuRecusar(
      sellerRecipientId,
      totalInCents,
      platformFeeInCents,
    );

    let pagarmeOrder: any;
    try {
      pagarmeOrder = await this.pagarme.post(
        '/orders',
        {
          customer_id: cardRef.customerId,
          items: [
            {
              amount: totalInCents,
              description: `Arremate Kolecta #${order.id.slice(0, 8)}`,
              quantity: 1,
              code: 'kolecta-bid-payment',
            },
          ],
          payments: [
            {
              payment_method: 'credit_card',
              credit_card: {
                capture: true, // cobrança à vista (captura imediata)
                statement_descriptor: 'KOLECTA',
                card_id: cardRef.cardId,
                ...(split ? { split } : {}),
              },
            },
          ],
          metadata: { type: 'bid_payment', orderId: order.id, buyerId },
        },
        `bid-pay-${order.id}-${Math.floor(Date.now() / 1000)}`,
      );
    } catch {
      throw new BadRequestException(
        'Não foi possível cobrar seu cartão. Tente outro cartão.',
      );
    }

    const charge = pagarmeOrder?.charges?.[0];
    const paid = pagarmeOrder?.status === 'paid' || charge?.status === 'paid';
    if (!paid) {
      const reason =
        charge?.last_transaction?.gateway_response?.errors?.[0]?.message ||
        charge?.last_transaction?.acquirer_message ||
        'Cartão recusado. Verifique os dados ou tente outro cartão.';
      throw new BadRequestException(reason);
    }

    await this._settlePaidAuctionOrder(
      order,
      pagarmeOrder.id,
      charge?.id ?? null,
    );

    // A cobrança do total passou — só agora a retenção do lance pode cair. A
    // ordem importa: liberar antes de cobrar deixaria o vencedor sem garantia
    // nenhuma no intervalo, e uma recusa aí custaria o item a ele.
    //
    // Best-effort: se o void falhar, o dinheiro do comprador segue retido até a
    // adquirente expirar a auth sozinha (~5 dias). Ruim, mas não desfaz a venda
    // — por isso fica em log e não derruba a resposta.
    const [auctionDoPedido] = await this.db
      .select({ id: schema.auctions.id })
      .from(schema.auctions)
      .where(eq(schema.auctions.listingId, order.listingId));
    if (auctionDoPedido) {
      const auth = await this._getActiveBidAuth(auctionDoPedido.id, buyerId);
      if (auth?.chargeId && auth.chargeId !== charge?.id) {
        await this._voidPreAuth(auth.chargeId);
        this.logger.log(
          `Pré-auth ${auth.chargeId} do lance liberada após o pagamento do arremate ${order.id}.`,
        );
      }
    }

    this.logger.log(
      `💳 Arremate ${order.id} pago pelo vencedor: pagarme ${pagarmeOrder.id} ` +
        `(total R$${(order.totalInCents / 100).toFixed(2)}, frete ` +
        `R$${((order.shippingInCents ?? 0) / 100).toFixed(2)}).`,
    );

    // Dispara a etiqueta. Evento próprio, e não `auction.won` de novo: aquele
    // já saiu no fecho pedindo a escolha do frete, e reemitir só para acionar a
    // etiqueta dependeria da deduplicação do MailService para não mandar um
    // segundo e-mail contraditório.
    this.eventEmitter.emit('auction.paid', {
      orderId: order.id,
      buyerId,
      sellerId: order.sellerId,
      totalInCents: order.totalInCents,
      shippingInCents: order.shippingInCents ?? 0,
      deliveryMethod: order.deliveryMethod ?? 'shipping',
    });

    return { orderId: order.id, paid: true };
  }

  /**
   * Consolida um pedido de arremate PAGO (pelo pagamento do vencedor): pedido →
   * `paid`, anúncio → `sold`, lance do comprador → `won`, líquido do vendedor
   * retido na wallet (proteção ao comprador).
   */
  private async _settlePaidAuctionOrder(
    order: typeof schema.orders.$inferSelect,
    pagarmeOrderId: string,
    pagarmeChargeId: string | null,
  ) {
    const [auction] = await this.db
      .select({ id: schema.auctions.id })
      .from(schema.auctions)
      .where(eq(schema.auctions.listingId, order.listingId));

    // O pedido nasceu `pending_payment` com taxa de gateway zero — correto na
    // hora, porque nada tinha sido cobrado. Agora foi: a Pagar.me desconta a
    // taxa do vendedor no split, então o espelho precisa acompanhar, aqui e no
    // hold logo abaixo. Sem isto o arremate pago em atraso repetia o saldo
    // inflado que o arremate normal já corrigia.
    const gatewayFeeInCents = calcGatewayFeeInCents(
      order.externalAmountInCents ?? order.totalInCents,
      order.paymentInstrument,
    );
    const sellerNetInCentsComTaxa =
      (order.sellerNetInCents ?? order.totalInCents) - gatewayFeeInCents;

    await this.db.transaction(async (tx: any) => {
      await tx
        .update(schema.orders)
        .set({
          status: 'paid',
          pagarmeOrderId,
          pagarmeChargeId,
          gatewayFeeInCents,
          sellerNetInCents: sellerNetInCentsComTaxa,
          paymentDeadlineAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.orders.id, order.id));
      await tx
        .update(schema.listings)
        .set({ status: 'sold' })
        .where(eq(schema.listings.id, order.listingId));
      if (auction) {
        await tx
          .update(schema.bids)
          .set({ status: 'won' })
          .where(
            and(
              eq(schema.bids.auctionId, auction.id),
              eq(schema.bids.bidderId, order.buyerId),
            ),
          );
      }
    });

    try {
      const sellerWallet = await this.walletService.getOrCreateWallet(
        order.sellerId,
      );
      await this.walletService.hold(
        sellerWallet.id,
        sellerNetInCentsComTaxa,
        `Arremate #${order.id.slice(0, 8)} — líquido retido`,
        order.id,
      );
    } catch (err: any) {
      this.logger.error(
        `⚠️ Arremate ${order.id} pago, mas falhou o espelho do líquido do vendedor (${err?.message}).`,
      );
    }
  }

  /**
   * Expira arremates `pending_payment` cujo prazo venceu: cancela o pedido,
   * marca o lance do vencedor faltoso como `lost` e OFERECE ao 2º colocado
   * (novo pedido `pending_payment` + prazo) ou, sem 2º colocado apto, REABRE o
   * anúncio para a vitrine. Usado pelo cron.
   */
  async expireOverduePendingPayments(): Promise<{
    expired: string[];
    offered: string[];
    reopened: string[];
  }> {
    const now = new Date();
    const overdue = await this.db
      .select()
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.status, 'pending_payment'),
          isNotNull(schema.orders.paymentDeadlineAt),
          lte(schema.orders.paymentDeadlineAt, now),
        ),
      );

    const expired: string[] = [];
    const offered: string[] = [];
    const reopened: string[] = [];
    for (const order of overdue) {
      try {
        const outcome = await this._expirePendingPayment(order);
        if (outcome === 'noop') continue;
        expired.push(order.id);
        if (outcome === 'offered') offered.push(order.id);
        else if (outcome === 'reopened') reopened.push(order.id);
      } catch (err: any) {
        this.logger.error(
          `Falha ao expirar pedido ${order.id}: ${err?.message}`,
        );
      }
    }
    return { expired, offered, reopened };
  }

  private async _expirePendingPayment(
    order: typeof schema.orders.$inferSelect,
  ): Promise<'offered' | 'reopened' | 'noop'> {
    // Cancela o pedido de forma atômica (guard de status evita corrida com o
    // pagamento do vencedor chegando no mesmo instante).
    const cancelled = await this.db
      .update(schema.orders)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(schema.orders.id, order.id),
          eq(schema.orders.status, 'pending_payment'),
        ),
      )
      .returning();
    if (cancelled.length === 0) return 'noop';

    const [auction] = await this.db
      .select()
      .from(schema.auctions)
      .where(eq(schema.auctions.listingId, order.listingId));

    if (auction) {
      // LIBERA a retenção do faltoso antes de qualquer outra coisa.
      //
      // Virou obrigatório quando o fecho parou de capturar: agora todo arremate
      // nasce `pending_payment` com uma pré-auth VIVA segurando o cartão. Sem
      // este void, quem simplesmente desistiu ficaria com o limite preso até a
      // adquirente expirar a auth sozinha (~5 dias) — e o valor some da fatura
      // sem nunca ter virado compra, que é o pior tipo de cobrança fantasma.
      const auth = await this._getActiveBidAuth(auction.id, order.buyerId);
      if (auth?.chargeId) {
        await this._voidPreAuth(auth.chargeId);
        this.logger.log(
          `Pré-auth ${auth.chargeId} liberada — arremate ${order.id} expirou sem pagamento.`,
        );
      }

      // O lance do vencedor faltoso vira 'lost' (sai da fila do 2º colocado).
      await this.db
        .update(schema.bids)
        .set({ status: 'lost' })
        .where(
          and(
            eq(schema.bids.auctionId, auction.id),
            eq(schema.bids.bidderId, order.buyerId),
          ),
        );
    }

    const runnerUp = auction
      ? await this._findRunnerUp(auction, order.buyerId)
      : null;

    if (runnerUp) {
      const platformFeePercent =
        await this.founderService.resolveCommissionPercent(order.sellerId);
      const platformFeeInCents = Math.round(
        (runnerUp.amountInCents * platformFeePercent) / 100,
      );
      const sellerNetInCents = runnerUp.amountInCents - platformFeeInCents;
      const enderecoRunnerUp = await this._getDefaultAddressId(
        runnerUp.bidderId,
      );
      const novoPedidoId: string = await this.db.transaction(
        async (tx: any) => {
          const [novo] = await tx
            .insert(schema.orders)
            .values({
              buyerId: runnerUp.bidderId,
              sellerId: order.sellerId,
              listingId: order.listingId,
              addressId: enderecoRunnerUp,
              // Sem frete: o 2º colocado escolhe o dele, com o CEP dele.
              totalInCents: runnerUp.amountInCents,
              shippingInCents: 0,
              sellerNetInCents,
              platformFeeInCents,
              gatewayFeeInCents: 0,
              status: 'pending_payment',
              paymentMethod: 'external',
              paymentInstrument: 'credit_card',
              externalAmountInCents: runnerUp.amountInCents,
              walletAmountInCents: 0,
              paymentDeadlineAt: new Date(
                Date.now() + PAYMENT_DEADLINE_HOURS * 60 * 60 * 1000,
              ),
            })
            .returning();
          // Promove o lance do 2º colocado (vira o vencedor a pagar).
          await tx
            .update(schema.bids)
            .set({ status: 'won' })
            .where(eq(schema.bids.id, runnerUp.bidId));
          // Anúncio segue reservado (pending_payment) para o 2º colocado.
          await tx
            .update(schema.listings)
            .set({ status: 'pending_payment' })
            .where(eq(schema.listings.id, order.listingId));
          return novo.id as string;
        },
      );
      this.logger.warn(
        `⏱️ Arremate ${order.id} expirado. Oferecido ao 2º colocado ${runnerUp.bidderId} ` +
          `(R$${(runnerUp.amountInCents / 100).toFixed(2)}) — pedido ${novoPedidoId}.`,
      );

      // O promovido tem um prazo correndo e precisa escolher o frete. Sem este
      // aviso ele era promovido no silêncio, e agora que a escolha de entrega é
      // obrigatória o silêncio garantiria que o prazo vencesse de novo.
      const [anuncio] = await this.db
        .select({ title: schema.listings.title })
        .from(schema.listings)
        .where(eq(schema.listings.id, order.listingId));
      this.eventEmitter.emit('auction.won', {
        orderId: novoPedidoId,
        winnerId: runnerUp.bidderId,
        listingTitle: anuncio?.title ?? 'Item Kolecta',
        finalAmountInCents: runnerUp.amountInCents,
        needsPayment: true,
        needsShippingChoice: true,
        paymentDeadlineHours: PAYMENT_DEADLINE_HOURS,
      });

      return 'offered';
    }

    // Sem 2º colocado apto → reabre o anúncio (volta pra vitrine).
    await this.db
      .update(schema.listings)
      .set({ status: 'active' })
      .where(eq(schema.listings.id, order.listingId));
    this.logger.warn(
      `⏱️ Arremate ${order.id} expirado sem 2º colocado apto. Anúncio ${order.listingId} reaberto.`,
    );
    return 'reopened';
  }

  /**
   * Maior lance de um participante ainda ELEGÍVEL: bidder que não teve lance
   * marcado como `lost` (nem é o vencedor faltoso), respeitando a reserva.
   */
  private async _findRunnerUp(
    auction: typeof schema.auctions.$inferSelect,
    excludeBidderId: string,
  ): Promise<{
    bidId: string;
    bidderId: string;
    amountInCents: number;
  } | null> {
    const bids = await this.db
      .select({
        bidId: schema.bids.id,
        bidderId: schema.bids.bidderId,
        amountInCents: schema.bids.amountInCents,
        status: schema.bids.status,
      })
      .from(schema.bids)
      .where(eq(schema.bids.auctionId, auction.id))
      .orderBy(desc(schema.bids.amountInCents));

    const ineligible = new Set(
      bids.filter((b) => b.status === 'lost').map((b) => b.bidderId),
    );
    ineligible.add(excludeBidderId);
    const reserve = auction.reservePriceInCents ?? 0;
    for (const b of bids) {
      if (ineligible.has(b.bidderId)) continue;
      if (b.amountInCents < reserve) continue;
      return {
        bidId: b.bidId,
        bidderId: b.bidderId,
        amountInCents: b.amountInCents,
      };
    }
    return null;
  }

  // ── Meus lances (comprador) — melhor lance por leilão ────────────────────

  async findMyBids(bidderId: string) {
    const bids = await this.db
      .select({
        id: schema.bids.id,
        auctionId: schema.bids.auctionId,
        amountInCents: schema.bids.amountInCents,
        createdAt: schema.bids.createdAt,
        // O status do LANCE distingue arremate já pago ('won') de arremate
        // esperando o vencedor ('active' num leilão encerrado). Sem ele a tela
        // deduzia tudo de `auctionStatus` e mostrava "aguardando pagamento"
        // para quem já tinha pago.
        status: schema.bids.status,
        auctionStatus: schema.auctions.status,
        auctionEndsAt: schema.auctions.endsAt,
        currentBidInCents: schema.auctions.currentBidInCents,
        currentWinnerId: schema.auctions.currentWinnerId,
        listingId: schema.auctions.listingId,
        title: schema.listings.title,
        images: schema.listings.images,
      })
      .from(schema.bids)
      .innerJoin(schema.auctions, eq(schema.bids.auctionId, schema.auctions.id))
      .innerJoin(
        schema.listings,
        eq(schema.auctions.listingId, schema.listings.id),
      )
      .where(eq(schema.bids.bidderId, bidderId))
      .orderBy(desc(schema.bids.amountInCents));

    // Mantém apenas o maior lance de cada leilão
    const best = new Map<string, (typeof bids)[number]>();
    for (const bid of bids) {
      if (!best.has(bid.auctionId)) best.set(bid.auctionId, bid);
    }
    return Array.from(best.values());
  }

  // ── Encerrar leilão manualmente (seller/admin) ───────────────────────────

  async endAuction(auctionId: string, requesterId: string) {
    const [auction] = await this.db
      .select()
      .from(schema.auctions)
      .where(eq(schema.auctions.id, auctionId));

    if (!auction) throw new NotFoundException('Leilão não encontrado');
    if (auction.status !== 'active') {
      throw new BadRequestException('O leilão não está mais ativo');
    }

    const [listing] = await this.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.id, auction.listingId));

    const [requester] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, requesterId));

    const isAdmin = requester?.role === 'admin';

    if (!isAdmin && listing?.sellerId !== requesterId) {
      throw new ForbiddenException(
        'Apenas o vendedor ou um admin pode encerrar este leilão',
      );
    }

    return this._closeAuction(auction, listing);
  }

  // ── Encerrar leilões expirados (usado pelo cron) ─────────────────────────

  async endExpiredAuctions() {
    const now = new Date();
    const expired = await this.db
      .select()
      .from(schema.auctions)
      .where(
        and(
          eq(schema.auctions.status, 'active'),
          lte(schema.auctions.endsAt, now),
          // Pausado não encerra: o relógio dele está congelado e ninguém pôde
          // disputar enquanto o lance esteve suspenso.
          isNull(schema.auctions.pausedAt),
        ),
      );

    if (expired.length === 0) return [];

    const results: string[] = [];

    for (const auction of expired) {
      const [listing] = await this.db
        .select()
        .from(schema.listings)
        .where(eq(schema.listings.id, auction.listingId));

      try {
        await this._closeAuction(auction, listing);
        results.push(auction.id);
      } catch (err: any) {
        this.logger.error(
          `Falha ao fechar leilão ${auction.id}: ${err.message}`,
        );
      }
    }

    return results;
  }

  // ── Lógica interna de fechamento ─────────────────────────────────────────

  private async _closeAuction(
    auction: typeof schema.auctions.$inferSelect,
    listing: typeof schema.listings.$inferSelect | undefined,
  ) {
    // Comissão efetiva do vendedor (aplica taxa de fundador quando cabível).
    const platformFeePercent = listing?.sellerId
      ? await this.founderService.resolveCommissionPercent(listing.sellerId)
      : parseInt(process.env.PLATFORM_FEE_PERCENT ?? '11', 10);

    const hasWinner = !!auction.currentWinnerId && !!auction.currentBidInCents;
    const reserveMet =
      !auction.reservePriceInCents ||
      (auction.currentBidInCents ?? 0) >= auction.reservePriceInCents;

    // Auth vigente do vencedor (pré-autorização a capturar/cancelar).
    const winnerAuth = hasWinner
      ? await this._getActiveBidAuth(auction.id, auction.currentWinnerId!)
      : null;

    // ── Sem venda: encerra e CANCELA a pré-auth do (eventual) arrematante ──
    if (!hasWinner || !reserveMet) {
      await this.db
        .update(schema.auctions)
        .set({ status: 'ended', updatedAt: new Date() })
        .where(eq(schema.auctions.id, auction.id));

      if (hasWinner) {
        // Reserva não atingida → libera a retenção no cartão do arrematante.
        if (winnerAuth?.chargeId) await this._voidPreAuth(winnerAuth.chargeId);
        await this.db
          .update(schema.bids)
          .set({ status: 'released' })
          .where(
            and(
              eq(schema.bids.auctionId, auction.id),
              eq(schema.bids.status, 'active'),
            ),
          );
        this.logger.log(
          `Leilão ${auction.id} encerrado sem venda (reserva não atingida). Pré-auth cancelada.`,
        );
      } else {
        this.logger.log(`Leilão ${auction.id} encerrado sem vencedor.`);
      }
      return;
    }

    // ── Venda: o vencedor ainda precisa ESCOLHER O FRETE ──
    //
    // Nada é capturado aqui, de propósito. O leilão não tem checkout, então o
    // lance cobre só a peça — o frete é escolhido pelo vencedor depois do fecho
    // e entra no MESMO total. Como não dá para capturar acima do valor
    // autorizado, capturar o lance agora obrigaria a uma segunda cobrança só do
    // frete (duas linhas na fatura, e o risco de item pago sem envio pago).
    //
    // A pré-autorização do lance NÃO é cancelada: ela segue segurando o cartão
    // como garantia enquanto o vencedor decide. Some só quando a cobrança do
    // total passa (`payAuctionOrder`) ou quando o prazo vence
    // (`_expirePendingPayment`).
    const bidInCents = auction.currentBidInCents!;
    const platformFeeInCents = Math.round(
      (bidInCents * platformFeePercent) / 100,
    );
    // Líquido do vendedor = lance − comissão. Não muda quando o frete entra: o
    // frete é somado ao total E à parte da plataforma, então a fatia do
    // vendedor é a mesma (mesma regra da venda direta, `orders.service.ts`).
    // A taxa do gateway é descontada só na hora do pagamento, em
    // `_settlePaidAuctionOrder`, porque aqui ainda não houve cobrança.
    const sellerNetInCents = bidInCents - platformFeeInCents;

    const enderecoVencedor = await this._getDefaultAddressId(
      auction.currentWinnerId!,
    );
    const orderId: string = await this.db.transaction(async (tx: any) => {
      await tx
        .update(schema.auctions)
        .set({ status: 'ended', updatedAt: new Date() })
        .where(eq(schema.auctions.id, auction.id));

      const [order] = await tx
        .insert(schema.orders)
        .values({
          buyerId: auction.currentWinnerId!,
          sellerId: listing!.sellerId,
          listingId: auction.listingId,
          addressId: enderecoVencedor,
          // Sem frete ainda: `chooseShipping` soma e regrava o total.
          totalInCents: bidInCents,
          shippingInCents: 0,
          sellerNetInCents,
          platformFeeInCents,
          gatewayFeeInCents: 0,
          status: 'pending_payment',
          paymentMethod: 'external',
          paymentInstrument: 'credit_card',
          externalAmountInCents: bidInCents,
          walletAmountInCents: 0,
          // Prazo para escolher o frete e pagar, antes de expirar.
          paymentDeadlineAt: new Date(
            Date.now() + PAYMENT_DEADLINE_HOURS * 60 * 60 * 1000,
          ),
        })
        .returning();

      await tx
        .update(schema.listings)
        .set({ status: 'pending_payment' })
        .where(eq(schema.listings.id, auction.listingId));

      return order.id as string;
    });

    this.logger.log(
      `Leilão ${auction.id} arrematado por ${auction.currentWinnerId} — ` +
        `R$${(bidInCents / 100).toFixed(2)}. Pedido ${orderId} aguardando ` +
        `escolha de frete e pagamento (prazo ${PAYMENT_DEADLINE_HOURS}h).` +
        (winnerAuth?.chargeId
          ? ` Pré-auth ${winnerAuth.chargeId} mantida como garantia.`
          : ` ⚠️ Sem pré-auth vigente — a cobrança dependerá do cartão salvo.`),
    );

    this.eventEmitter.emit('auction.won', {
      orderId,
      winnerId: auction.currentWinnerId!,
      listingTitle: listing!.title,
      finalAmountInCents: bidInCents,
      needsPayment: true,
      needsShippingChoice: true,
      paymentDeadlineHours: PAYMENT_DEADLINE_HOURS,
    });
  }

  /**
   * Reenvia ao vencedor o aviso de que ele arrematou.
   *
   * O aviso original sai UMA vez, no fecho, e não havia como repeti-lo. Quando
   * ele se perde — cadastro com e-mail inválido, caixa cheia, provedor fora — o
   * vencedor simplesmente nunca fica sabendo, e o relógio corre igual: vencido o
   * prazo, a pré-auth é liberada e a peça vai para o 2º colocado. Foi o que
   * quase aconteceu em 11/08/2026 com dois arremates (R$ 460) de um comprador
   * cujo cadastro tinha e-mail placeholder.
   *
   * O e-mail é lido do banco na HORA do envio (`auction.listener`), então
   * consertar o cadastro e chamar isto aqui basta — não é preciso reprocessar
   * nada do leilão.
   *
   * Não reabre o leilão nem estende o prazo: só avisa. E só vale para
   * `pending_payment` — pedido pago não tem aviso a dar, cancelado não tem mais
   * o que pagar.
   */
  async reenviarAvisoDeArremate(orderId: string): Promise<{
    orderId: string;
    destinatario: string;
    horasRestantes: number | null;
    precisaEscolherFrete: boolean;
  }> {
    const order = await this.db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });
    if (!order)
      throw new NotFoundException(`Pedido ${orderId} não encontrado.`);

    if (order.status !== 'pending_payment') {
      throw new BadRequestException(
        `Pedido ${orderId} está '${order.status}'. O aviso de arremate só faz ` +
          `sentido em 'pending_payment'.`,
      );
    }

    const auction = await this.db.query.auctions.findFirst({
      where: eq(schema.auctions.listingId, order.listingId),
    });
    if (!auction) {
      throw new BadRequestException(
        `Pedido ${orderId} não veio de leilão — não há aviso de arremate.`,
      );
    }

    const listing = await this.db.query.listings.findFirst({
      where: eq(schema.listings.id, order.listingId),
    });
    const vencedor = await this.db.query.users.findFirst({
      where: eq(schema.users.id, order.buyerId),
    });
    if (!vencedor?.email) {
      throw new BadRequestException(
        `Vencedor ${order.buyerId} não tem e-mail cadastrado — conserte o ` +
          `cadastro antes de reenviar, senão o aviso se perde de novo.`,
      );
    }

    // Prazo REAL que sobra, não as 48h originais: o e-mail chega depois e
    // prometer o prazo cheio de novo faria o vencedor se planejar pelo número
    // errado.
    const horasRestantes = order.paymentDeadlineAt
      ? Math.max(
          0,
          (order.paymentDeadlineAt.getTime() - Date.now()) / 3_600_000,
        )
      : null;

    // O frete só está pendente se ele ainda não escolheu — reenviar não pode
    // pedir de novo o que já foi feito.
    const precisaEscolherFrete =
      !order.shippingServiceId &&
      (order.deliveryMethod ?? 'shipping') !== 'pickup';

    this.eventEmitter.emit('auction.won', {
      orderId,
      winnerId: order.buyerId,
      listingTitle: listing?.title ?? 'Item Kolecta',
      // Só a peça: o frete ainda não foi escolhido, então somá-lo aqui mostraria
      // um total que o vencedor não reconheceria.
      finalAmountInCents: order.totalInCents - (order.shippingInCents ?? 0),
      needsPayment: true,
      needsShippingChoice: precisaEscolherFrete,
      paymentDeadlineHours:
        horasRestantes == null
          ? PAYMENT_DEADLINE_HOURS
          : Math.floor(horasRestantes),
    });

    this.logger.log(
      `Aviso de arremate reenviado (pedido ${orderId}) para ${vencedor.email} — ` +
        `restam ${horasRestantes?.toFixed(1) ?? '?'}h.`,
    );

    return {
      orderId,
      destinatario: vencedor.email,
      horasRestantes:
        horasRestantes == null ? null : Number(horasRestantes.toFixed(1)),
      precisaEscolherFrete,
    };
  }
}
