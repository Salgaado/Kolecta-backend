import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../../database/database.module';
import * as schema from '../../database/schema';
import { MailService } from '../mail/mail.service';

interface PayoutReleasedEvent {
  walletId: string;
  userId: string;
  amountInCents: number;
  orderId: string | null;
}

/**
 * E-mail de repasse liberado. O evento sai do ponto único de release na
 * WalletService, então cobre tanto a confirmação manual do comprador quanto o
 * release automático de 48h — sem duplicar lógica nos dois caminhos.
 */
@Injectable()
export class FinanceListener {
  private readonly logger = new Logger(FinanceListener.name);

  constructor(
    private readonly mail: MailService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  @OnEvent('payout.released')
  async handleReleased(event: PayoutReleasedEvent): Promise<void> {
    const [seller] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, event.userId));

    if (!seller?.email) {
      this.logger.warn(
        `Usuário ${event.userId} sem e-mail — "payout-released" não enviado.`,
      );
      return;
    }

    await this.mail.send({
      to: seller.email,
      template: 'payout-released',
      // refId pelo pedido: o release de um pedido acontece uma vez só.
      refId: event.orderId
        ? `payout-${event.orderId}`
        : `payout-${event.walletId}-${event.amountInCents}`,
      data: {
        sellerName: seller.name,
        amountInCents: event.amountInCents,
        orderId: event.orderId,
      },
    });
  }
}
