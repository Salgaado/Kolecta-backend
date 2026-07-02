import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../../database/database.module';
import * as schema from '../../database/schema';
import { MailService } from '../mail/mail.service';

// Mesmo payload emitido em orders.service.ts (`order.paid`).
interface OrderPaidEvent {
  orderId: string;
  sellerId: string;
  buyerId: string;
  buyerName: string | null;
  buyerEmail: string;
  listingTitle: string;
  totalInCents: number;
}

@Injectable()
export class OrderListener {
  private readonly logger = new Logger(OrderListener.name);

  constructor(
    private readonly mail: MailService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  @OnEvent('order.paid')
  async handleOrderPaid(event: OrderPaidEvent): Promise<void> {
    // (1) Comprador — "Pedido confirmado"
    await this.mail.send({
      to: event.buyerEmail,
      template: 'order-confirmed',
      refId: event.orderId,
      data: {
        buyerName: event.buyerName,
        orderId: event.orderId,
        listingTitle: event.listingTitle,
        totalInCents: event.totalInCents,
      },
    });

    // (2) Vendedor — "Você fez uma venda!" (e-mail do seller não vem no evento)
    const [seller] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, event.sellerId));

    if (!seller?.email) {
      this.logger.warn(
        `Seller ${event.sellerId} sem e-mail — "sale-made" do pedido ${event.orderId} não enviado.`,
      );
      return;
    }

    await this.mail.send({
      to: seller.email,
      template: 'sale-made',
      refId: event.orderId,
      data: {
        sellerName: seller.name,
        orderId: event.orderId,
        listingTitle: event.listingTitle,
        totalInCents: event.totalInCents,
      },
    });
  }
}
