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
import { nomeDeExibicaoDoVendedor } from '../common/nome-do-vendedor';
import { calcGatewayFeeInCents } from '../common/gateway-fees';
import { WalletService } from '../wallet/wallet.service';
import { FounderService } from '../founder/founder.service';
import { CardsService } from '../cards/cards.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { buildSplit, PagarmeSplit } from '../pagarme/pagarme-split';
import { motivoPagarme } from '../pagarme/pagarme-erro';
import { ConciliacaoService } from '../pagarme/conciliacao.service';
import type { PagarmeAddress } from '../cards/cards.service';
import { ShippingService } from '../shipping/shipping.service';
import { FreteSubsidioService } from '../shipping/frete-subsidio.service';
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
 * fundos por ~5 dias, e esse número é o TETO de tudo aqui: nenhum leilão desta
 * plataforma cabe dentro dele (7 a 30 dias), então a retenção não acompanha o
 * leilão — ela é armada na reta final. Configurável por
 * `PAGARME_PREAUTH_VALIDITY_DAYS`.
 */
const AUTH_VALIDITY_DAYS = parseInt(
  process.env.PAGARME_PREAUTH_VALIDITY_DAYS ?? '5',
  10,
);

/** Item discriminado na order da Pagar.me (o antifraude lê a descrição). */
interface PagarmeItem {
  amount: number;
  description: string;
  quantity: number;
  code: string;
}

/** Destino da entrega na order. Sem `amount` — ver `_contextoAntifraude`. */
interface PagarmeShipping {
  description: string;
  recipient_name: string;
  address: PagarmeAddress;
}

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

/**
 * Margem de segurança (horas) descontada da janela de retenção.
 *
 * `AUTH_VALIDITY_DAYS` é ESTIMATIVA nossa, não um contrato: bandeira e emissor
 * às vezes devolvem o saldo antes do prazo. A margem é o quanto a garantia pode
 * cair mais cedo sem deixar o arremate sem cobertura.
 */
const HOLD_MARGIN_HOURS = parseInt(
  process.env.PAGARME_HOLD_MARGIN_HOURS ?? '12',
  10,
);

/**
 * Teto de autorizações que um único lance pode gerar no cartão do comprador.
 *
 * É a trava que faltava. O cron antigo era um laço sem memória — falhava,
 * mantinha a auth velha e tentava de novo em 6h, para sempre. Um lance de R$45
 * num leilão de 14 dias virou 16 recusas seguidas no cartão de quem nem tinha
 * arrematado (caso de 24/08/2026). Agora a conta é persistida no lance e
 * NENHUM cartão vê mais que isto, aconteça o que acontecer.
 */
const HOLD_MAX_ATTEMPTS = parseInt(
  process.env.PAGARME_HOLD_MAX_ATTEMPTS ?? '3',
  10,
);

/** Espera antes de cada nova tentativa, por número da tentativa já feita. */
const HOLD_RETRY_BACKOFF_HOURS = [1, 6, 24];

/** Intervalo mínimo entre duas conferências da MESMA retenção na Pagar.me. */
const HOLD_RECHECK_HOURS = parseInt(
  process.env.PAGARME_HOLD_RECHECK_HOURS ?? '6',
  10,
);

/**
 * A RETA FINAL: quanto antes do fecho a retenção do líder pode ser armada.
 *
 * Uma pré-autorização vive ~5 a 7 dias. Os leilões daqui duram de 7 a 30 (95 de
 * 147 passam da validade), então reter no ato do lance obrigava a emendar uma
 * corrente de retenções curtas ao longo do leilão — e cada emenda era uma
 * autorização nova no cartão de alguém, que podia ser recusada. A corrente
 * nunca funcionou: em toda a história da plataforma, zero renovações.
 *
 * A retenção passa a nascer no único momento em que ela CABE: perto o bastante
 * do fim para sobreviver ao fecho mais o prazo de pagamento do vencedor. Uma
 * autorização por lance, nenhuma renovação, e o limite do comprador livre
 * durante quase todo o leilão.
 *
 * validade − prazo de pagamento − margem. Com 7 dias de validade: 132h (5,5
 * dias). Nunca menos que 1h, para o cálculo não virar janela negativa se
 * alguém configurar validade menor que o prazo.
 */
function janelaDeRetencaoHoras(): number {
  return Math.max(
    AUTH_VALIDITY_DAYS * 24 - PAYMENT_DEADLINE_HOURS - HOLD_MARGIN_HOURS,
    1,
  );
}

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
    // Frete compartilhado: o leilão só sabe o preço no fim, então o subsídio é
    // aplicado quando o vencedor escolhe o frete (`chooseShipping`).
    private readonly freteSubsidio: FreteSubsidioService,
    private readonly conciliacao: ConciliacaoService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Nome de exibição do vendedor, na mesma régua da vitrine — a regra mora em
   * `common/nome-do-vendedor.ts`.
   *
   * O leilão não trazia nome nenhum: o select tinha só `sellerId`, e a página
   * de lance chumbava "Vendedor Kolecta" no lugar. Duas lojas diferentes
   * apareciam com o mesmo nome, e o comprador não sabia de quem estava
   * comprando na hora de dar lance.
   */
  private readonly sellerDisplayName =
    nomeDeExibicaoDoVendedor().as('seller_name');

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

    // ── Retenção só na RETA FINAL ──
    //
    // Fora dela o lance NÃO retém nada. Uma pré-autorização vive ~5 a 7 dias e
    // os leilões daqui vão a 30: reter no ato obrigava a emendar uma corrente
    // de retenções ao longo do leilão, e cada emenda era uma autorização nova
    // no cartão. A garantia é armada depois, quando cabe até o fecho
    // (`armarRetencoesDeLideres`), e até lá o limite do comprador fica livre.
    //
    // O cartão continua sendo conferido no ato: `getCardRef` acima consulta a
    // Pagar.me e devolve null quando o cadastro não existe mais. O que não
    // acontece é bloquear dinheiro por semanas.
    //
    // Quando cria, cria ANTES de assumir a liderança; se perdermos a corrida de
    // concorrência abaixo, cancelamos a auth (rollback). Lança BadRequest com o
    // motivo da Pagar.me quando o cartão é recusado.
    const preAuth = this._naRetaFinal(auction.endsAt)
      ? await this._createBidPreAuth({
          customerId: cardRef.customerId,
          cardId: cardRef.cardId,
          amountInCents: dto.amountInCents,
          auctionId,
          bidderId,
          sellerId: listing.sellerId,
          sellerRecipientId,
          billingAddress,
        })
      : null;

    let bid: typeof schema.bids.$inferSelect;
    try {
      bid = await this.db.transaction(async (tx: any) => {
        const [newBid] = await tx
          .insert(schema.bids)
          .values({
            auctionId,
            bidderId,
            amountInCents: dto.amountInCents,
            // Sem retenção os quatro campos ficam nulos — estado normal fora da
            // reta final, e é `armarRetencoesDeLideres` que os preenche depois.
            // `holdAttempts` já nasce em 1 quando retém: a autorização do lance
            // conta para o teto como qualquer outra.
            ...(preAuth
              ? {
                  pagarmeOrderId: preAuth.orderId,
                  pagarmeChargeId: preAuth.chargeId,
                  pagarmeCardId: cardRef.cardId,
                  authExpiresAt: preAuth.expiresAt,
                  holdAttempts: 1,
                  holdCheckedAt: new Date(),
                }
              : {}),
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
      // Perdeu a corrida (ou erro) → cancela a retenção recém-criada, se houve.
      if (preAuth) await this._voidPreAuth(preAuth.chargeId);
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

  /**
   * Auth vigente (order/charge) do lance ativo de um usuário no leilão.
   *
   * Devolve também o VALOR autorizado: é ele que pode ser capturado no
   * arremate, e capturar acima do autorizado não é permitido.
   */
  private async _getActiveBidAuth(
    auctionId: string,
    bidderId: string,
  ): Promise<{
    chargeId: string | null;
    orderId: string | null;
    amountInCents: number;
  } | null> {
    const [b] = await this.db
      .select({
        chargeId: schema.bids.pagarmeChargeId,
        orderId: schema.bids.pagarmeOrderId,
        amountInCents: schema.bids.amountInCents,
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
    } catch (err: unknown) {
      // NÃO engolir o motivo: antes o catch trocava qualquer falha por "tente
      // outro cartão", e um erro de DOCUMENTO ou de endereço virava um problema
      // de cartão aos olhos de quem dava o lance — impossível de diagnosticar
      // sem abrir o log do servidor.
      const detalhe = motivoPagarme(err);
      this.logger.error(
        `Pré-autorização do lance falhou (leilão ${params.auctionId}, ` +
          `bidder ${params.bidderId}): ` +
          JSON.stringify((err as { response?: unknown })?.response ?? detalhe),
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

  // ── Fase 3: a retenção do líder, armada na reta final ────────────────────
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

  /**
   * Arma a retenção do líder quando o leilão entra na RETA FINAL.
   *
   * Substitui a renovação em corrente. Antes, o lance retinha no ato e este
   * cron emendava retenções curtas ao longo de um leilão longo — a cada 6h,
   * sem teto, sem backoff e sem avisar ninguém quando o cartão recusava. Um
   * lance de R$45 num leilão de 14 dias virou 16 recusas seguidas (24/08/2026),
   * e a corrente nunca chegou a funcionar: zero renovações bem-sucedidas em
   * toda a história da plataforma.
   *
   * O que este cron faz agora, para cada líder de leilão que fecha dentro da
   * janela ({@link janelaDeRetencaoHoras}):
   *
   * - **sem retenção** → cria UMA, respeitando {@link HOLD_MAX_ATTEMPTS} e o
   *   backoff. Estourou o teto: para de vez e avisa o licitante.
   * - **com retenção** → confere na Pagar.me, no máximo a cada
   *   {@link HOLD_RECHECK_HOURS}. Se sumiu do cartão (emissor devolve o saldo
   *   antes do prazo, sem avisar), solta o vínculo e rearma — dentro do MESMO
   *   teto, que é o que impede a conferência de virar um laço novo.
   *
   * Falhar degrada seguro: sem garantia, o fecho cria o pedido
   * `pending_payment` de sempre e o vencedor paga do zero no prazo (Fase 4).
   */
  async armarRetencoesDeLideres(): Promise<{
    armadas: string[];
    falhas: string[];
    desistidas: string[];
  }> {
    const agora = new Date();
    const limite = new Date(
      agora.getTime() + janelaDeRetencaoHoras() * 60 * 60 * 1000,
    );

    const rows = await this.db
      .select({
        bidId: schema.bids.id,
        auctionId: schema.bids.auctionId,
        bidderId: schema.bids.bidderId,
        amountInCents: schema.bids.amountInCents,
        chargeId: schema.bids.pagarmeChargeId,
        attempts: schema.bids.holdAttempts,
        nextAttemptAt: schema.bids.holdNextAttemptAt,
        checkedAt: schema.bids.holdCheckedAt,
        sellerId: schema.listings.sellerId,
        listingId: schema.listings.id,
        listingTitle: schema.listings.title,
        endsAt: schema.auctions.endsAt,
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
          // Pausado não entra: o relógio dele está congelado, então `endsAt` é
          // uma data velha que colocaria o leilão na janela sem ele estar perto
          // do fim de verdade.
          isNull(schema.auctions.pausedAt),
          lte(schema.auctions.endsAt, limite),
        ),
      );

    const armadas: string[] = [];
    const falhas: string[] = [];
    const desistidas: string[] = [];

    for (const row of rows) {
      // ── Já tem retenção: confere se ela ainda existe ──
      if (row.chargeId) {
        const conferidaHaPouco =
          !!row.checkedAt &&
          row.checkedAt.getTime() + HOLD_RECHECK_HOURS * 60 * 60 * 1000 >
            agora.getTime();
        if (conferidaHaPouco) continue;

        const retida = await this._preAuthAindaRetida(row.chargeId);
        await this.db
          .update(schema.bids)
          .set({ holdCheckedAt: agora })
          .where(eq(schema.bids.id, row.bidId));

        // De pé, ou dúvida (`null`) → não mexe. Ver `_preAuthAindaRetida`.
        if (retida !== false) continue;

        this.logger.warn(
          `Retenção ${row.chargeId} do lance ${row.bidId} sumiu do cartão ` +
            `antes do prazo. Rearmando.`,
        );
        await this.db
          .update(schema.bids)
          .set({
            pagarmeOrderId: null,
            pagarmeChargeId: null,
            authExpiresAt: null,
          })
          .where(
            and(
              eq(schema.bids.id, row.bidId),
              eq(schema.bids.status, 'active'),
              eq(schema.bids.pagarmeChargeId, row.chargeId),
            ),
          );
      }

      // ── Sem retenção: arma, se ainda houver tentativa ──
      if (row.attempts >= HOLD_MAX_ATTEMPTS) continue;
      if (row.nextAttemptAt && row.nextAttemptAt > agora) continue;

      // A tentativa é contada ANTES de falar com a Pagar.me. Contar depois
      // deixaria o teto furado justamente no cenário que ele existe para
      // cobrir: processo derrubado no meio da chamada, tentativa nunca
      // registrada, e o laço de volta.
      const tentativa = row.attempts + 1;
      await this.db
        .update(schema.bids)
        .set({ holdAttempts: tentativa })
        .where(eq(schema.bids.id, row.bidId));

      try {
        if (await this._armarRetencao(row)) {
          armadas.push(row.bidId);
          this.logger.log(
            `Retenção armada no lance ${row.bidId} ` +
              `(tentativa ${tentativa}/${HOLD_MAX_ATTEMPTS}).`,
          );
        }
      } catch (err: any) {
        const motivo = String(err?.message ?? err).slice(0, 500);
        const desistiu = tentativa >= HOLD_MAX_ATTEMPTS;
        const espera =
          HOLD_RETRY_BACKOFF_HOURS[
            Math.min(tentativa, HOLD_RETRY_BACKOFF_HOURS.length) - 1
          ];

        await this.db
          .update(schema.bids)
          .set({
            holdLastError: motivo,
            holdNextAttemptAt: desistiu
              ? null
              : new Date(agora.getTime() + espera * 60 * 60 * 1000),
          })
          .where(eq(schema.bids.id, row.bidId));

        if (!desistiu) {
          falhas.push(row.bidId);
          this.logger.warn(
            `Retenção do lance ${row.bidId} falhou ` +
              `(${tentativa}/${HOLD_MAX_ATTEMPTS}, nova tentativa em ${espera}h): ${motivo}`,
          );
          continue;
        }

        desistidas.push(row.bidId);
        this.logger.error(
          `Retenção do lance ${row.bidId} DESISTIDA após ${tentativa} ` +
            `tentativas: ${motivo}. O arremate, se houver, será cobrado do ` +
            `zero dentro do prazo de pagamento.`,
        );
        // Avisar é parte da correção: antes, o cartão do comprador era recusado
        // repetidamente e nem ele nem a plataforma ficavam sabendo.
        this.eventEmitter.emit('auction.bid-hold-failed', {
          auctionId: row.auctionId,
          listingId: row.listingId,
          listingTitle: row.listingTitle,
          bidderId: row.bidderId,
          amountInCents: row.amountInCents,
          endsAt: row.endsAt,
          paymentDeadlineHours: PAYMENT_DEADLINE_HOURS,
        });
      }
    }

    return { armadas, falhas, desistidas };
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

  /**
   * O leilão já está perto o bastante do fim para a retenção caber?
   *
   * "Caber" é sobreviver ao fecho MAIS o prazo de pagamento do vencedor — a
   * garantia só serve se ainda estiver de pé na hora da captura. Leilão sem
   * data de fim nunca cabe.
   */
  private _naRetaFinal(endsAt: Date | null): boolean {
    if (!endsAt) return false;
    return (
      endsAt.getTime() <= Date.now() + janelaDeRetencaoHoras() * 60 * 60 * 1000
    );
  }

  /**
   * Cria a retenção de um lance líder e amarra ao lance.
   *
   * Devolve `false` quando o lance mudou no meio do caminho (foi superado, ou
   * já ganhou retenção por outro caminho): a auth recém-criada é desfeita e
   * nada é gravado. Lança quando a Pagar.me recusa — aí é falha de verdade, e
   * quem chama conta a tentativa e aplica o backoff.
   */
  private async _armarRetencao(row: {
    bidId: string;
    auctionId: string;
    bidderId: string;
    amountInCents: number;
    sellerId: string;
  }): Promise<boolean> {
    const cardRef = await this.cardsService.getCardRef(row.bidderId);
    if (!cardRef) {
      throw new Error(
        `licitante ${row.bidderId} está sem cartão salvo (removido depois do lance)`,
      );
    }

    const fresh = await this._createBidPreAuth({
      customerId: cardRef.customerId,
      cardId: cardRef.cardId,
      amountInCents: row.amountInCents,
      auctionId: row.auctionId,
      bidderId: row.bidderId,
      sellerId: row.sellerId,
      sellerRecipientId: await this._getSellerRecipientId(row.sellerId),
      billingAddress: await this._getBillingAddress(row.bidderId),
    });

    // Só amarra se o lance AINDA é o líder e continua sem retenção. `isNull`
    // no lugar da comparação com a auth antiga: aqui não existe troca, existe
    // arme — e armar por cima de retenção existente é justamente o que prendia
    // dois valores no limite do comprador ao mesmo tempo.
    const armado = await this.db
      .update(schema.bids)
      .set({
        pagarmeOrderId: fresh.orderId,
        pagarmeChargeId: fresh.chargeId,
        pagarmeCardId: cardRef.cardId,
        authExpiresAt: fresh.expiresAt,
        holdCheckedAt: new Date(),
        holdLastError: null,
        holdNextAttemptAt: null,
      })
      .where(
        and(
          eq(schema.bids.id, row.bidId),
          eq(schema.bids.status, 'active'),
          isNull(schema.bids.pagarmeChargeId),
        ),
      )
      .returning();

    if (armado.length === 0) {
      await this._voidPreAuth(fresh.chargeId);
      this.logger.warn(
        `Retenção ${fresh.chargeId} desfeita: o lance ${row.bidId} mudou durante o arme.`,
      );
      return false;
    }
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
    // Custo cheio da etiqueta e o que a Kolecta bancou. Em retirada em mãos os
    // três ficam zero, e a invariante `cost = shipping + subsidy` se mantém.
    let shippingCostInCents = 0;
    let shippingSubsidyInCents = 0;
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

      shippingServiceId = Number(escolhida.raw.id);
      shippingServiceName = `${escolhida.carrier} ${escolhida.service}`;

      // Frete compartilhado. O leilão só sabe o preço do item no fim, então é
      // AQUI que o subsídio pode ser calculado — e é por isso que a página do
      // leilão nunca promete "frete grátis", no máximo "frete grátis se
      // arrematar acima de R$ X".
      //
      // A âncora é a opção mais barata da rota, não a escolhida: quem prefere
      // transportadora cara paga a diferença inteira. Mesma regra da venda
      // direta (`orders.service.ts:resolverFrete`).
      const resolvido = await this.freteSubsidio.resolver({
        itemInCents: bidInCents,
        freteEscolhidoInCents: Math.round(escolhida.price * 100),
        opcoesEmCentavos: (cotacao?.options ?? [])
          .filter((o: any) => o?.raw?.id && Number.isFinite(o.price))
          .map((o: any) => Math.round(o.price * 100)),
        contexto: `Arremate ${order.id}`,
      });

      shippingInCents = resolvido.shippingInCents;
      shippingCostInCents = resolvido.shippingCostInCents;
      shippingSubsidyInCents = resolvido.shippingSubsidyInCents;
    }

    // O frete vai INTEIRO para a Kolecta, que compra a etiqueta — mesma regra
    // da venda direta (`orders.service.ts`). A comissão continua incidindo só
    // sobre o item. O líquido do vendedor, portanto, não muda com o frete.
    //
    // `shippingInCents` é o frete COBRADO do comprador (já descontado o
    // subsídio), e é justamente por isso que esta linha não muda com o frete
    // compartilhado: `platformFee = comissão + o que o comprador pagou de
    // frete` continua sendo exatamente o valor do split.
    const totalInCents = bidInCents + shippingInCents;
    const platformFeeInCents = comissaoInCents + shippingInCents;

    const gravado = await this.db
      .update(schema.orders)
      .set({
        addressId,
        deliveryMethod: dto.deliveryMethod,
        shippingInCents,
        shippingCostInCents,
        shippingSubsidyInCents,
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
   * Itens discriminados e destino da entrega para a cobrança do arremate — o
   * material que o antifraude usa para decidir.
   *
   * Uma linha só ("Arremate Kolecta #abc123") não identifica produto nem
   * destino: o que chega é um valor solto, indistinguível de teste de cartão.
   * O checkout discrimina desde `3ba9a4e` e aprova normalmente; este caminho
   * ficou para trás e teve um arremate barrado em 12/08.
   */
  private async _contextoAntifraude(
    order: typeof schema.orders.$inferSelect,
  ): Promise<{ itens: PagarmeItem[]; entrega: PagarmeShipping | null }> {
    const shippingInCents = order.shippingInCents ?? 0;

    const [listing] = await this.db
      .select({ title: schema.listings.title })
      .from(schema.listings)
      .where(eq(schema.listings.id, order.listingId));

    const detalhados: PagarmeItem[] = [
      {
        amount: this._bidPartOf(order),
        description: (listing?.title || 'Item Kolecta').slice(0, 250),
        quantity: 1,
        code: order.listingId.slice(0, 52),
      },
      ...(shippingInCents > 0
        ? [
            {
              amount: shippingInCents,
              description: 'Frete',
              quantity: 1,
              code: 'frete',
            },
          ]
        : []),
    ];

    // A soma dos itens TEM que bater com o valor cobrado — a Pagar.me recusa a
    // order inteira se divergir. Na dúvida volta para a linha única, que é
    // sempre correta: contexto melhor não vale uma cobrança recusada.
    const soma = detalhados.reduce((t, i) => t + i.amount, 0);
    const itens =
      soma === order.totalInCents && detalhados[0].amount > 0
        ? detalhados
        : [
            {
              amount: order.totalInCents,
              description: `Arremate Kolecta #${order.id.slice(0, 8)}`,
              quantity: 1,
              code: 'kolecta-bid-payment',
            },
          ];

    // Retirada em mãos não tem destino a declarar.
    if (order.deliveryMethod !== 'shipping' || !order.addressId) {
      return { itens, entrega: null };
    }

    const [end] = await this.db
      .select()
      .from(schema.addresses)
      .where(eq(schema.addresses.id, order.addressId));
    if (!end) return { itens, entrega: null };

    return {
      itens,
      // SEM `amount` de propósito: com ele a Pagar.me SOMA o valor ao total
      // (verificado na API — 2553 virou 4106) e o comprador pagaria o frete
      // duas vezes. Sem ele o bloco é aceito, o total não muda e o antifraude
      // passa a enxergar para onde vai a peça.
      entrega: {
        description: 'Entrega Kolecta',
        recipient_name: end.recipientName || 'Comprador',
        address: {
          line_1: [end.number, end.street, end.neighborhood]
            .filter(Boolean)
            .join(', '),
          ...(end.complement ? { line_2: end.complement } : {}),
          zip_code: String(end.zip).replace(/\D/g, ''),
          city: end.city,
          state: end.state,
          country: (end.country || 'BR').toUpperCase(),
        },
      },
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

    // ── Endereço de cobrança (a Pagar.me EXIGE no cartão) ──
    // O cartão salvo nasce só do token (`cards.service.ts` posta `{ token }`),
    // e o token não carrega endereço — a tokenização no navegador manda apenas
    // número/nome/validade/CVV. Então o endereço precisa vir DAQUI, a cada
    // cobrança, como já vem no lance e no checkout. Sem ele a Pagar.me recusa a
    // cobrança inteira com `validation_error | billing | "value" is required`,
    // antes de qualquer análise de risco.
    //
    // Vem do cadastro, e não do endereço do pedido, porque na retirada em mãos
    // não há endereço de entrega — e o cartão exige endereço do mesmo jeito.
    const billingAddress = await this._getBillingAddress(buyerId);
    if (!billingAddress) {
      throw new BadRequestException(
        'Cadastre um endereço em Minha Conta para pagar — a operadora exige ' +
          'endereço de cobrança do titular do cartão.',
      );
    }

    // ── A retenção do lance É o pagamento da peça ──
    // O lance já bloqueou no cartão exatamente o valor da peça. Cobrar de novo
    // do zero, como se fazia, obrigava o comprador a ter o DOBRO do limite:
    // quem desse um lance de R$500 com R$500 de limite ganhava o leilão e não
    // conseguia arrematar. Uma pré-autorização existe para virar cobrança —
    // então ela é capturada, e só o frete (que ela não cobria) vira cobrança
    // nova.
    const [auctionDoPedido] = await this.db
      .select({ id: schema.auctions.id })
      .from(schema.auctions)
      .where(eq(schema.auctions.listingId, order.listingId));
    const auth = auctionDoPedido
      ? await this._getActiveBidAuth(auctionDoPedido.id, buyerId)
      : null;

    const bidInCents = this._bidPartOf(order);
    // Só serve se cobrir a peça inteira: capturar acima do autorizado não é
    // permitido, e capturar A MENOS deixaria a diferença sem pagamento.
    const retencaoCobreAPeca =
      !!auth?.chargeId && auth.amountInCents === bidInCents;
    // `_preAuthAindaRetida` devolve `null` quando não deu para saber, e aqui a
    // dúvida pesa para o lado da CAPTURA (só `false` desvia para o fallback).
    // O motivo é assimétrico: se a retenção existir e mesmo assim cobrarmos do
    // zero, o comprador fica com os dois valores presos — o problema que esta
    // mudança existe para acabar. Se ela não existir e tentarmos capturar, a
    // captura falha, nada é cobrado e ele tenta de novo.
    const retencaoDePe =
      retencaoCobreAPeca &&
      (await this._preAuthAindaRetida(auth!.chargeId!)) !== false;

    if (retencaoDePe) {
      return await this._pagarCapturandoRetencao(
        order,
        auth!.chargeId!,
        bidInCents,
        cardRef,
        billingAddress,
      );
    }

    // Fallback: sem retenção utilizável (expirada, cancelada, ou valor que não
    // bate), cobra o total do zero. É o caminho antigo — mantido porque um
    // arremate não pode ficar impagável só porque a garantia caiu.
    this.logger.warn(
      `Arremate ${order.id}: sem retenção utilizável (auth ${auth?.chargeId ?? 'nenhuma'}, ` +
        `autorizado ${auth?.amountInCents ?? 0} vs peça ${bidInCents}). Cobrando o total do zero.`,
    );

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

    // ── Itens e destino para a Pagar.me (leitura do antifraude) ──
    // "Arremate Kolecta #c7a6babf" não diz nada a quem avalia risco: some o
    // produto, some o destino, e o que sobra é indistinguível de teste de
    // cartão. Mesma regra do checkout (`orders.service.ts`), que aprova.
    const { itens, entrega } = await this._contextoAntifraude(order);

    let pagarmeOrder: any;
    try {
      pagarmeOrder = await this.pagarme.post(
        '/orders',
        {
          customer_id: cardRef.customerId,
          items: itens,
          ...(entrega ? { shipping: entrega } : {}),
          payments: [
            {
              payment_method: 'credit_card',
              credit_card: {
                capture: true, // cobrança à vista (captura imediata)
                statement_descriptor: 'KOLECTA',
                card_id: cardRef.cardId,
                card: { billing_address: billingAddress },
                ...(split ? { split } : {}),
              },
            },
          ],
          metadata: { type: 'bid_payment', orderId: order.id, buyerId },
        },
        `bid-pay-${order.id}-${Math.floor(Date.now() / 1000)}`,
      );
    } catch (err: unknown) {
      // NÃO engolir o motivo — mesma lição do lance (`_createBidPreAuth`). Este
      // catch trocava QUALQUER falha por "tente outro cartão", e foi ele que
      // escondeu a ausência do `billing_address` acima: o vencedor era mandado
      // trocar de cartão por um erro que não era do cartão, e o servidor não
      // registrava nada.
      const detalhe = motivoPagarme(err);
      this.logger.error(
        `Cobrança do arremate ${order.id} falhou (comprador ${buyerId}): ` +
          JSON.stringify((err as { response?: unknown })?.response ?? detalhe),
      );
      throw new BadRequestException(
        detalhe
          ? `Não foi possível cobrar seu cartão: ${detalhe}`
          : 'Não foi possível cobrar seu cartão. Tente outro cartão.',
      );
    }

    const charge = pagarmeOrder?.charges?.[0];
    const paid = pagarmeOrder?.status === 'paid' || charge?.status === 'paid';
    if (!paid) {
      // Guarda a referência ANTES de desistir. A recusa não é o fim da
      // história: ela pode ser reprocessada no painel da Pagar.me, e sem o id
      // aqui não há como perguntar depois se virou pagamento — foi assim que
      // um arremate de R$200 pago em 12/08 ficou sem rastro do nosso lado.
      // O pedido segue `pending_payment`; só a referência é gravada.
      if (pagarmeOrder?.id) {
        await this.db
          .update(schema.orders)
          .set({ pagarmeOrderId: pagarmeOrder.id, updatedAt: new Date() })
          .where(eq(schema.orders.id, order.id));
      }
      const reason =
        charge?.last_transaction?.gateway_response?.errors?.[0]?.message ||
        charge?.last_transaction?.acquirer_message ||
        'Cartão recusado. Verifique os dados ou tente outro cartão.';
      throw new BadRequestException(reason);
    }

    await this._concluirArrematePago(
      order,
      pagarmeOrder.id,
      charge?.id ?? null,
    );

    return { orderId: order.id, paid: true };
  }

  /**
   * Paga o arremate CAPTURANDO a retenção do lance.
   *
   * A peça já está bloqueada no cartão desde o lance — capturar transforma o
   * bloqueio na cobrança, sem pedir limite novo. Só o frete, que a retenção não
   * cobria, vira cobrança à parte.
   *
   * A ordem é frete → captura, e não o contrário, porque a operação com risco
   * real de recusa é a do frete (cartão novo, limite novo); a captura de uma
   * auth viva quase sempre passa. Falhando primeiro o que tem mais chance de
   * falhar, o abandono é limpo: nada foi capturado e o pedido segue
   * `pending_payment`. Na ordem inversa, a falha provável deixaria a peça paga
   * e o envio não — o risco que o `151a361` levantou com razão.
   *
   * O split não muda: a retenção já nasceu com ele (peça − comissão para o
   * vendedor, comissão para a Kolecta), e o frete vai 100% para a Kolecta, que
   * compra a etiqueta. Mesmo resultado financeiro da cobrança única anterior.
   */
  private async _pagarCapturandoRetencao(
    order: typeof schema.orders.$inferSelect,
    chargeIdRetencao: string,
    bidInCents: number,
    cardRef: { customerId: string; cardId: string },
    billingAddress: PagarmeAddress,
  ) {
    const shippingInCents = order.shippingInCents ?? 0;

    // 1) Frete primeiro (quando há). Recusa aqui não custa nada: a retenção
    //    segue intacta e ele tenta de novo.
    let freteChargeId: string | null = null;
    if (shippingInCents > 0) {
      freteChargeId = await this._cobrarFreteAvulso(
        order,
        shippingInCents,
        cardRef,
        billingAddress,
      );
    }

    // 2) Captura da peça.
    try {
      await this._capturarRetencao(chargeIdRetencao, bidInCents);
    } catch (err: unknown) {
      // O frete já passou e a peça não: devolver o frete é o único desfecho
      // honesto — ele não recebe nada por ele. Best-effort, e o motivo fica no
      // log para o caso de o estorno também falhar.
      if (freteChargeId) {
        try {
          await this.pagarme.delete(`/charges/${freteChargeId}`);
          this.logger.warn(
            `Frete ${freteChargeId} estornado: a captura da peça falhou no arremate ${order.id}.`,
          );
        } catch (errEstorno: unknown) {
          this.logger.error(
            `⚠️ Frete ${freteChargeId} do arremate ${order.id} NÃO estornado ` +
              `após falha na captura: ${motivoPagarme(errEstorno)}. Devolver à mão.`,
          );
        }
      }
      const detalhe = motivoPagarme(err);
      this.logger.error(
        `Captura da retenção ${chargeIdRetencao} falhou (arremate ${order.id}): ${detalhe}`,
      );
      throw new BadRequestException(
        detalhe
          ? `Não foi possível concluir o pagamento: ${detalhe}`
          : 'Não foi possível concluir o pagamento. Tente novamente.',
      );
    }

    this.logger.log(
      `💳 Arremate ${order.id} pago por CAPTURA da retenção ${chargeIdRetencao} ` +
        `(peça R$${(bidInCents / 100).toFixed(2)})` +
        (freteChargeId
          ? ` + frete ${freteChargeId} (R$${(shippingInCents / 100).toFixed(2)})`
          : ' (retirada em mãos)') +
        '. Nenhum limite adicional foi exigido pela peça.',
    );

    // O charge da consolidação é o da retenção capturada — e é isso que faz o
    // `_concluirArrematePago` NÃO tentar cancelá-la: ela virou o pagamento.
    await this._concluirArrematePago(
      order,
      order.pagarmeOrderId ?? chargeIdRetencao,
      chargeIdRetencao,
    );

    return { orderId: order.id, paid: true };
  }

  /**
   * Cobra SÓ o frete, à vista, numa cobrança própria.
   *
   * Sem split de propósito: o frete vai inteiro para a Kolecta, que compra a
   * etiqueta. Sem `split`, a Pagar.me credita a conta da plataforma — que é
   * exatamente o destino certo.
   */
  private async _cobrarFreteAvulso(
    order: typeof schema.orders.$inferSelect,
    shippingInCents: number,
    cardRef: { customerId: string; cardId: string },
    billingAddress: PagarmeAddress,
  ): Promise<string> {
    let resposta: any;
    try {
      resposta = await this.pagarme.post(
        '/orders',
        {
          customer_id: cardRef.customerId,
          items: [
            {
              amount: shippingInCents,
              description: `Frete do arremate #${order.id.slice(0, 8)}`,
              quantity: 1,
              code: 'frete',
            },
          ],
          payments: [
            {
              payment_method: 'credit_card',
              credit_card: {
                capture: true,
                statement_descriptor: 'KOLECTA',
                card_id: cardRef.cardId,
                card: { billing_address: billingAddress },
              },
            },
          ],
          // `orderId` no metadata é o que liga esta cobrança ao pedido: não há
          // coluna para um segundo charge, então a ligação vive do lado da
          // Pagar.me e no log.
          metadata: {
            type: 'bid_shipping',
            orderId: order.id,
            buyerId: order.buyerId,
          },
        },
        `bid-frete-${order.id}`,
      );
    } catch (err: unknown) {
      const detalhe = motivoPagarme(err);
      this.logger.error(
        `Cobrança do frete do arremate ${order.id} falhou: ${detalhe}`,
      );
      throw new BadRequestException(
        detalhe
          ? `Não foi possível cobrar o frete: ${detalhe}`
          : 'Não foi possível cobrar o frete. Tente outro cartão.',
      );
    }

    const charge = resposta?.charges?.[0];
    const pago = resposta?.status === 'paid' || charge?.status === 'paid';
    if (!pago) {
      const motivo =
        charge?.last_transaction?.gateway_response?.errors?.[0]?.message ||
        charge?.last_transaction?.acquirer_message ||
        'Cobrança do frete recusada. Verifique os dados ou tente outro cartão.';
      throw new BadRequestException(motivo);
    }
    return charge?.id ?? resposta.id;
  }

  /**
   * Captura uma pré-autorização pelo valor autorizado. Lança se não confirmar.
   *
   * Reintroduz o `_captureCharge` removido no `151a361` — a captura era o
   * caminho certo; o que estava errado era achar que ela obrigava a cobrar o
   * frete junto.
   */
  private async _capturarRetencao(
    chargeId: string,
    amountInCents: number,
  ): Promise<void> {
    const captured = await this.pagarme.post(
      `/charges/${chargeId}/capture`,
      { amount: amountInCents },
      `bid-capture-${chargeId}`,
    );
    const status = captured?.status ?? captured?.last_transaction?.status;
    if (status !== 'paid') {
      throw new Error(
        `Captura da retenção ${chargeId} não confirmada (status: ${status}).`,
      );
    }
  }

  /**
   * Tudo que acontece DEPOIS de a cobrança do arremate ser confirmada:
   * consolida o pedido, libera a retenção do lance e dispara a etiqueta.
   *
   * Compartilhado de propósito entre o pagamento pelo site (`payAuctionOrder`)
   * e a conciliação pelo webhook (`handlePagarmeAuctionPaid`) — porque foi a
   * AUSÊNCIA desse compartilhamento que deixou um arremate pago pelo painel da
   * Pagar.me sem nada registrado aqui: o site liquidava tudo dentro da própria
   * requisição, o webhook era redundante, e ninguém notou que ele não sabia
   * fazer o trabalho sozinho.
   */
  private async _concluirArrematePago(
    order: typeof schema.orders.$inferSelect,
    pagarmeOrderId: string,
    chargeId: string | null,
  ) {
    // A retenção do lance é LIDA ANTES de consolidar, e só liberada depois.
    //
    // A ordem não é estilo: `_settlePaidAuctionOrder` marca o lance vencedor
    // como `won` dentro da transação, e `_getActiveBidAuth` filtra por
    // `status = 'active'`. Lendo depois, a busca não acha mais nada e o void
    // NUNCA acontecia — o vencedor ficava com o valor cobrado E o valor retido
    // presos ao mesmo tempo, até a adquirente expirar a auth sozinha (~5 dias).
    // Dois arremates de 11/08 ficaram assim, R$ 460 travados sem necessidade.
    //
    // Liberar só DEPOIS da consolidação continua certo: a retenção é a garantia
    // enquanto o dinheiro não entrou.
    const [auctionDoPedido] = await this.db
      .select({ id: schema.auctions.id })
      .from(schema.auctions)
      .where(eq(schema.auctions.listingId, order.listingId));
    const auth = auctionDoPedido
      ? await this._getActiveBidAuth(auctionDoPedido.id, order.buyerId)
      : null;

    await this._settlePaidAuctionOrder(order, pagarmeOrderId, chargeId);

    // Best-effort: se o void falhar, o dinheiro do comprador segue retido até a
    // adquirente expirar a auth sozinha. Ruim, mas não desfaz a venda — por
    // isso fica em log e não derruba a resposta.
    if (auth?.chargeId && auth.chargeId !== chargeId) {
      await this._voidPreAuth(auth.chargeId);
      this.logger.log(
        `Pré-auth ${auth.chargeId} do lance liberada após o pagamento do arremate ${order.id}.`,
      );
    }

    this.logger.log(
      `💳 Arremate ${order.id} pago pelo vencedor: pagarme ${pagarmeOrderId} ` +
        `(total R$${(order.totalInCents / 100).toFixed(2)}, frete ` +
        `R$${((order.shippingInCents ?? 0) / 100).toFixed(2)}).`,
    );

    // Dispara a etiqueta. Evento próprio, e não `auction.won` de novo: aquele
    // já saiu no fecho pedindo a escolha do frete, e reemitir só para acionar a
    // etiqueta dependeria da deduplicação do MailService para não mandar um
    // segundo e-mail contraditório.
    this.eventEmitter.emit('auction.paid', {
      orderId: order.id,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      totalInCents: order.totalInCents,
      shippingInCents: order.shippingInCents ?? 0,
      deliveryMethod: order.deliveryMethod ?? 'shipping',
    });
  }

  /**
   * Arremate pago FORA do fluxo do site: reprocessamento no painel da Pagar.me,
   * ou qualquer cobrança que a nossa requisição não acompanhou até o fim.
   *
   * Existe porque o `order.paid` do leilão caía no handler do CHECKOUT, que só
   * conhece o status `pending` — o pedido de leilão fica `pending_payment`.
   * Nomes parecidos, estados diferentes: o webhook lia, achava que já estava
   * resolvido, saía calado e era gravado como `processed`. Um arremate de
   * R$ 200 foi pago em 12/08 e ficou invisível aqui — a caminho de ser
   * cancelado pelo cron de prazo, com o dinheiro já capturado.
   */
  @OnEvent('pagarme.auction.paid')
  async handlePagarmeAuctionPaid(data: any) {
    const orderId: string | undefined = data?.metadata?.orderId;
    if (!orderId) {
      this.logger.warn(
        `Pagar.me order.paid de arremate (${data?.id}) sem orderId no metadata. Ignorando.`,
      );
      return;
    }

    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));

    if (!order) {
      this.logger.warn(`order.paid de arremate: pedido ${orderId} não existe.`);
      return;
    }

    // Idempotência: no caminho normal o site já liquidou dentro da requisição e
    // o webhook chega logo atrás. Sair calado aqui é o esperado, não um erro.
    if (order.status !== 'pending_payment') {
      this.logger.log(
        `Arremate ${orderId} já estava ${order.status} — webhook sem efeito.`,
      );
      return;
    }

    const charge = data?.charges?.[0];
    await this._concluirArrematePago(
      order,
      data?.id ?? 'pagarme',
      charge?.id ?? null,
    );

    this.logger.log(
      `✅ Arremate ${orderId} conciliado PELO WEBHOOK (pago fora do site).`,
    );
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
        // ── Portão: ninguém é cancelado sem PERGUNTAR à Pagar.me ──
        // Cancelar um pedido já pago é o pior desfecho possível: o item vai ao
        // 2º colocado com o dinheiro do 1º capturado. Aconteceu quase isso em
        // 12/08 — um arremate pago pelo painel ficou `pending_payment` porque o
        // webhook falhou, e este cron o cancelaria no dia seguinte.
        //
        // A dúvida também segura o cancelamento: se a consulta falhar, não
        // sabemos, e não saber não autoriza destruir uma venda. Fica para a
        // próxima rodada, com alerta.
        const conciliado = await this.conciliacao.conciliarPedido(order.id);
        if (conciliado.acao === 'liquidado') {
          this.logger.warn(
            `Pedido ${order.id} venceu o prazo mas estava PAGO na Pagar.me — ` +
              'liquidado em vez de cancelado.',
          );
          continue;
        }
        if (conciliado.acao === 'erro-consulta') {
          this.logger.error(
            `🚨 Pedido ${order.id} venceu o prazo e a Pagar.me não respondeu ` +
              `(${conciliado.detalhe}). NÃO cancelado — tenta na próxima rodada.`,
          );
          continue;
        }
        if (conciliado.acao === 'sem-referencia') {
          this.logger.warn(
            `Pedido ${order.id} vencido e sem referência na Pagar.me ` +
              '(nenhuma cobrança chegou a ser criada) — segue para cancelamento.',
          );
        }

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

      // O anúncio PRECISA sair do ar junto com o leilão.
      //
      // Antes daqui o fecho sem venda só mexia no leilão, e o anúncio ficava
      // `active` para sempre: aparecia na vitrine como leilão vivo, abria em
      // /modo-lance e não aceitava lance, porque o leilão tinha acabado.
      // `paused` é o estado certo — o vendedor vê no painel dele que a peça não
      // vendeu e decide se relista, em vez de descobrir por um comprador
      // reclamando que o botão não funciona.
      if (listing) {
        await this.db
          .update(schema.listings)
          .set({ status: 'paused', updatedAt: new Date() })
          .where(eq(schema.listings.id, listing.id));
      }

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
          `Leilão ${auction.id} encerrado sem venda (reserva não atingida). ` +
            `Pré-auth cancelada, anúncio ${auction.listingId} pausado.`,
        );

        // Avisa quem deu o maior lance. Sem este e-mail ele não descobria em
        // lugar nenhum que a reserva não foi atingida: a tela "Meus Lances" o
        // tratava como arrematante ("Escolha o frete", com um botão que caía
        // numa lista de pedidos vazia) e a página do leilão escondia o aviso de
        // reserva justamente depois de encerrar.
        this.eventEmitter.emit('auction.reserve-not-met', {
          auctionId: auction.id,
          listingId: auction.listingId,
          listingTitle: listing?.title ?? 'Item Kolecta',
          topBidderId: auction.currentWinnerId!,
          topBidInCents: auction.currentBidInCents!,
          reservePriceInCents: auction.reservePriceInCents!,
        });
      } else {
        this.logger.log(
          `Leilão ${auction.id} encerrado sem vencedor. ` +
            `Anúncio ${auction.listingId} pausado.`,
        );
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
