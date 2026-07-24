import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../../database/database.module';
import * as schema from '../../database/schema';
import { MailService } from '../mail/mail.service';

interface MessageReceivedEvent {
  conversationId: string;
  senderId: string;
  recipientId: string;
  listingId: string | null;
  content: string;
}

/** Trecho curto para o corpo e o preheader — não mandamos a mensagem inteira. */
function excerpt(text: string, max = 140): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

@Injectable()
export class MessageListener {
  private readonly logger = new Logger(MessageListener.name);

  constructor(
    private readonly mail: MailService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  @OnEvent('message.received')
  async handleReceived(event: MessageReceivedEvent): Promise<void> {
    const [recipient] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, event.recipientId));

    if (!recipient?.email) {
      this.logger.warn(
        `Destinatário ${event.recipientId} sem e-mail — "message-received" não enviado.`,
      );
      return;
    }

    const [sender] = await this.db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, event.senderId));

    let listingTitle: string | null = null;
    if (event.listingId) {
      const [listing] = await this.db
        .select({ title: schema.listings.title })
        .from(schema.listings)
        .where(eq(schema.listings.id, event.listingId));
      listingTitle = listing?.title ?? null;
    }

    await this.mail.send({
      to: recipient.email,
      template: 'message-received',
      // Sem refId: cada mensagem nova é um aviso legítimo. Usar a conversa como
      // refId silenciaria da segunda mensagem em diante.
      data: {
        recipientName: recipient.name,
        senderName: sender?.name ?? null,
        excerpt: excerpt(event.content),
        listingTitle,
      },
    });
  }
}
