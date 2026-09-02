import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq, count } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../../database/database.module';
import * as schema from '../../database/schema';
import { MailService } from '../mail/mail.service';

interface BidPlacedEvent {
  auctionId: string;
  listingId: string;
  listingTitle: string;
  sellerId: string;
  bidderId: string;
  amountInCents: number;
  /** Líder anterior, quando é outra pessoa. Null se não havia ou é o mesmo. */
  previousWinnerId: string | null;
  previousBidInCents: number | null;
  endsAt: Date | null;
}

interface AuctionWonEvent {
  orderId: string;
  winnerId: string;
  listingTitle: string;
  finalAmountInCents: number;
  needsPayment: boolean;
  /** Falta escolher frete/retirada — caminho normal desde o fecho sem captura. */
  needsShippingChoice?: boolean;
  paymentDeadlineHours?: number;
}

interface BidHoldFailedEvent {
  auctionId: string;
  listingId: string;
  listingTitle: string;
  bidderId: string;
  amountInCents: number;
  endsAt: Date | null;
  paymentDeadlineHours: number;
}

interface ReserveNotMetEvent {
  auctionId: string;
  listingId: string;
  listingTitle: string;
  /** Quem deu o maior lance — e mesmo assim NÃO arrematou. */
  topBidderId: string;
  topBidInCents: number;
  reservePriceInCents: number;
}

/** "2 dias", "5 horas", "40 minutos" — prazo legível para o e-mail. */
function humanizeDeadline(endsAt: Date | null): string | null {
  if (!endsAt) return null;
  const ms = endsAt.getTime() - Date.now();
  if (ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  const days = Math.round(hours / 24);
  return `${days} dias`;
}

@Injectable()
export class AuctionListener {
  private readonly logger = new Logger(AuctionListener.name);

  constructor(
    private readonly mail: MailService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  private async userById(id: string) {
    const [user] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, id));
    return user ?? null;
  }

  @OnEvent('auction.bid.placed')
  async handleBidPlaced(event: BidPlacedEvent): Promise<void> {
    // (1) Vendedor — "Novo lance no seu leilão"
    const seller = await this.userById(event.sellerId);
    if (seller?.email) {
      const [totals] = await this.db
        .select({ n: count() })
        .from(schema.bids)
        .where(eq(schema.bids.auctionId, event.auctionId));

      await this.mail.send({
        to: seller.email,
        template: 'bid-received',
        // refId pelo VALOR do lance: cada lance novo é um aviso novo, mas o
        // mesmo lance reprocessado não vira e-mail duplicado.
        refId: `bid-received-${event.auctionId}-${event.amountInCents}`,
        data: {
          sellerName: seller.name,
          auctionId: event.auctionId,
          listingTitle: event.listingTitle,
          amountInCents: event.amountInCents,
          totalBids: totals?.n ?? 1,
        },
      });
    }

    // (2) Líder anterior — "Cobriram o seu lance"
    if (!event.previousWinnerId) return;
    const outbid = await this.userById(event.previousWinnerId);
    if (!outbid?.email) {
      this.logger.warn(
        `Licitante ${event.previousWinnerId} sem e-mail — "bid-outbid" não enviado.`,
      );
      return;
    }

    await this.mail.send({
      to: outbid.email,
      template: 'bid-outbid',
      refId: `bid-outbid-${event.auctionId}-${event.amountInCents}`,
      data: {
        bidderName: outbid.name,
        auctionId: event.auctionId,
        listingTitle: event.listingTitle,
        yourBidInCents: event.previousBidInCents ?? 0,
        currentBidInCents: event.amountInCents,
        endsIn: humanizeDeadline(
          event.endsAt ? new Date(event.endsAt) : null,
        ),
      },
    });
  }

  /**
   * Maior lance abaixo da reserva — o leilão encerra SEM venda.
   *
   * Era o único desfecho de leilão que não avisava ninguém. Quem liderava
   * continuava vendo "Escolha o frete" em Meus Lances, com um botão que levava a
   * uma lista de pedidos vazia, e não tinha onde descobrir o motivo. Foi o que
   * prendeu dois compradores em 24/08 e 01/09/2026.
   */
  /**
   * A plataforma desistiu de reservar o valor do lance no cartão do líder.
   *
   * O que este e-mail conserta é o silêncio. Antes, o cron tentava reter a cada
   * 6h para sempre, e cada recusa morria no log do servidor: o comprador via as
   * tentativas irem e virem na fatura sem explicação nenhuma. Agora a
   * plataforma para depois de poucas tentativas — e diz o que houve.
   */
  @OnEvent('auction.bid-hold-failed')
  async handleBidHoldFailed(event: BidHoldFailedEvent): Promise<void> {
    const bidder = await this.userById(event.bidderId);
    if (!bidder?.email) {
      this.logger.warn(
        `Líder ${event.bidderId} sem e-mail — "bid-hold-failed" do leilão ` +
          `${event.auctionId} não enviado.`,
      );
      return;
    }

    await this.mail.send({
      to: bidder.email,
      template: 'bid-hold-failed',
      // Um aviso por lance-no-leilão: o teto é por lance, então a desistência
      // acontece uma vez só — mas o cron pode reprocessar a mesma linha.
      refId: `bid-hold-failed-${event.auctionId}-${event.bidderId}`,
      data: {
        bidderName: bidder.name,
        listingId: event.listingId,
        listingTitle: event.listingTitle,
        amountInCents: event.amountInCents,
        paymentDeadlineHours: event.paymentDeadlineHours,
      },
    });
  }

  @OnEvent('auction.reserve-not-met')
  async handleReserveNotMet(event: ReserveNotMetEvent): Promise<void> {
    const bidder = await this.userById(event.topBidderId);
    if (!bidder?.email) {
      this.logger.warn(
        `Maior licitante ${event.topBidderId} sem e-mail — ` +
          `"auction-reserve-not-met" do leilão ${event.auctionId} não enviado.`,
      );
      return;
    }

    await this.mail.send({
      to: bidder.email,
      template: 'auction-reserve-not-met',
      // Um aviso por leilão: o fecho é único, mas o cron pode reprocessar.
      refId: `auction-reserve-not-met-${event.auctionId}`,
      data: {
        bidderName: bidder.name,
        listingId: event.listingId,
        listingTitle: event.listingTitle,
        topBidInCents: event.topBidInCents,
        reservePriceInCents: event.reservePriceInCents,
      },
    });
  }

  @OnEvent('auction.won')
  async handleWon(event: AuctionWonEvent): Promise<void> {
    const winner = await this.userById(event.winnerId);
    if (!winner?.email) {
      this.logger.warn(
        `Vencedor ${event.winnerId} sem e-mail — "auction-won" do pedido ${event.orderId} não enviado.`,
      );
      return;
    }

    await this.mail.send({
      to: winner.email,
      template: 'auction-won',
      refId: `auction-won-${event.orderId}`,
      data: {
        winnerName: winner.name,
        orderId: event.orderId,
        listingTitle: event.listingTitle,
        finalAmountInCents: event.finalAmountInCents,
        needsPayment: event.needsPayment,
        needsShippingChoice: event.needsShippingChoice,
        paymentDeadlineHours: event.paymentDeadlineHours,
      },
    });
  }
}
