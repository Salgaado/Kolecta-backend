import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../../database/database.module';
import * as schema from '../../database/schema';
import { MailService } from '../mail/mail.service';

// Mesmo payload emitido em listings.service.ts (`listing.moderated`).
interface ListingModeratedEvent {
  template: 'listing-approved' | 'listing-rejected';
  listingId: string;
  sellerId: string;
  listingTitle: string;
  reason: string | null;
}

/**
 * E-mails de moderação de anúncio. Só chegam aqui quando um ADMIN mudou o
 * status (ver a guarda em ListingsService.updateStatus): publicação feita pelo
 * próprio vendedor não gera aviso.
 */
@Injectable()
export class ListingListener {
  private readonly logger = new Logger(ListingListener.name);

  constructor(
    private readonly mail: MailService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  @OnEvent('listing.moderated')
  async handleModerated(event: ListingModeratedEvent): Promise<void> {
    const [seller] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, event.sellerId));

    if (!seller?.email) {
      this.logger.warn(
        `Vendedor ${event.sellerId} sem e-mail — "${event.template}" do anúncio ${event.listingId} não enviado.`,
      );
      return;
    }

    await this.mail.send({
      to: seller.email,
      template: event.template,
      // refId inclui o desfecho: um anúncio pode ser reprovado, corrigido e
      // aprovado depois — os dois e-mails precisam sair.
      refId: `${event.template}-${event.listingId}`,
      data: {
        sellerName: seller.name,
        listingId: event.listingId,
        listingTitle: event.listingTitle,
        reason: event.reason,
      },
    });
  }
}
