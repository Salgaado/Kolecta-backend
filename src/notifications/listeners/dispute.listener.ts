import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../../database/database.module';
import * as schema from '../../database/schema';
import { MailService } from '../mail/mail.service';

interface DisputeOpenedEvent {
  disputeId: string;
  orderId: string;
  sellerId: string;
  listingId: string | null;
  reason: string | null;
}

@Injectable()
export class DisputeListener {
  private readonly logger = new Logger(DisputeListener.name);

  constructor(
    private readonly mail: MailService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  @OnEvent('dispute.opened')
  async handleOpened(event: DisputeOpenedEvent): Promise<void> {
    const [seller] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, event.sellerId));

    if (!seller?.email) {
      this.logger.warn(
        `Vendedor ${event.sellerId} sem e-mail — "dispute-opened" da disputa ${event.disputeId} não enviado.`,
      );
      return;
    }

    let listingTitle: string | null = null;
    if (event.listingId) {
      const [listing] = await this.db
        .select({ title: schema.listings.title })
        .from(schema.listings)
        .where(eq(schema.listings.id, event.listingId));
      listingTitle = listing?.title ?? null;
    }

    await this.mail.send({
      to: seller.email,
      template: 'dispute-opened',
      // Uma disputa aberta por pedido — o refId pela disputa basta.
      refId: `dispute-opened-${event.disputeId}`,
      data: {
        sellerName: seller.name,
        orderId: event.orderId,
        listingTitle,
        reason: event.reason,
      },
    });
  }
}
