import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, desc, and, or, ne, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { StartConversationDto, SendMessageDto } from './dto/messages.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class MessagesService {
  constructor(
    @Inject(DATABASE_CONNECTION) private db: LibSQLDatabase<typeof schema>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async getConversations(userId: string) {
    const buyers = alias(schema.users, 'buyers');
    const sellers = alias(schema.users, 'sellers');

    const rows = await this.db
      .select({
        conversation: schema.conversations,
        listing: schema.listings,
        buyer: buyers,
        seller: sellers,
      })
      .from(schema.conversations)
      .leftJoin(schema.listings, eq(schema.conversations.listingId, schema.listings.id))
      .leftJoin(buyers, eq(schema.conversations.buyerId, buyers.id))
      .leftJoin(sellers, eq(schema.conversations.sellerId, sellers.id))
      .where(
        or(
          eq(schema.conversations.buyerId, userId),
          eq(schema.conversations.sellerId, userId),
        ),
      )
      .orderBy(desc(schema.conversations.updatedAt));

    // For each conversation, get the unread count and latest message
    const result = await Promise.all(
      rows.map(async (row) => {
        const convId = row.conversation.id;
        const unreadMessages = await this.db
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.conversationId, convId),
              ne(schema.messages.senderId, userId), // Not sent by me
              isNull(schema.messages.readAt), // Not read
            ),
          );

        const [latestMessage] = await this.db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.conversationId, convId))
          .orderBy(desc(schema.messages.createdAt))
          .limit(1);

        return {
          ...row.conversation,
          listing: row.listing,
          buyer: row.buyer,
          seller: row.seller,
          unreadCount: unreadMessages.length,
          latestMessage: latestMessage || null,
        };
      }),
    );

    return result;
  }

  async getConversation(conversationId: string, userId: string) {
    const buyers = alias(schema.users, 'buyers');
    const sellers = alias(schema.users, 'sellers');

    const [row] = await this.db
      .select({
        conversation: schema.conversations,
        listing: schema.listings,
        buyer: buyers,
        seller: sellers,
      })
      .from(schema.conversations)
      .leftJoin(schema.listings, eq(schema.conversations.listingId, schema.listings.id))
      .leftJoin(buyers, eq(schema.conversations.buyerId, buyers.id))
      .leftJoin(sellers, eq(schema.conversations.sellerId, sellers.id))
      .where(eq(schema.conversations.id, conversationId));

    if (!row) {
      throw new NotFoundException('Conversa não encontrada');
    }

    if (row.conversation.buyerId !== userId && row.conversation.sellerId !== userId) {
      throw new ForbiddenException('Você não tem acesso a esta conversa');
    }

    const messagesList = await this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(schema.messages.createdAt);

    return {
      conversation: {
        ...row.conversation,
        listing: row.listing,
        buyer: row.buyer,
        seller: row.seller,
      },
      messages: messagesList,
    };
  }

  async startConversation(userId: string, dto: StartConversationDto) {
    const listing = await this.db.query.listings.findFirst({
      where: eq(schema.listings.id, dto.listingId),
    });

    if (!listing) {
      throw new NotFoundException('Anúncio não encontrado');
    }

    if (listing.sellerId === userId) {
      throw new BadRequestException('Você não pode iniciar uma conversa no seu próprio anúncio');
    }

    // Restrição: exige ao menos uma transação confirmada entre comprador e vendedor para este anúncio
    const confirmedOrder = await this.db.query.orders.findFirst({
      where: and(
        eq(schema.orders.buyerId, userId),
        eq(schema.orders.listingId, dto.listingId),
      ),
    });

    if (!confirmedOrder || !['paid', 'shipped', 'delivered', 'completed'].includes(confirmedOrder.status)) {
      throw new ForbiddenException(
        'O chat só está disponível após uma transação confirmada entre comprador e vendedor.',
      );
    }

    return this._createOrGetConversation(dto.listingId, userId, listing.sellerId, dto.message);
  }

  // ── Iniciar ou abrir conversa a partir de um pedido ──────────────────────────

  async startFromOrder(userId: string, orderId: string) {
    const order = await this.db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });

    if (!order) throw new NotFoundException('Pedido não encontrado');

    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException('Você não tem acesso a este pedido');
    }

    if (!['paid', 'shipped', 'delivered', 'completed'].includes(order.status)) {
      throw new ForbiddenException(
        'O chat só está disponível após o pagamento ser confirmado.',
      );
    }

    const { conversationId } = await this._createOrGetConversation(
      order.listingId,
      order.buyerId,
      order.sellerId,
    );

    return { conversationId };
  }

  // ── Lógica interna de criação/busca de conversa ───────────────────────────────

  private async _createOrGetConversation(
    listingId: string,
    buyerId: string,
    sellerId: string,
    firstMessage?: string,
  ) {
    const existing = await this.db.query.conversations.findFirst({
      where: and(
        eq(schema.conversations.listingId, listingId),
        eq(schema.conversations.buyerId, buyerId),
      ),
    });

    if (existing) {
      let message = null;
      if (firstMessage) {
        message = await this.sendMessage(buyerId, existing.id, { content: firstMessage });
      }
      return { conversationId: existing.id, message };
    }

    const [newConv] = await this.db.insert(schema.conversations).values({
      listingId,
      buyerId,
      sellerId,
    }).returning();

    let message = null;
    if (firstMessage) {
      const [msg] = await this.db.insert(schema.messages).values({
        conversationId: newConv.id,
        senderId: buyerId,
        content: firstMessage,
      }).returning();
      message = msg;
    }

    return { conversationId: newConv.id, message };
  }

  async sendMessage(userId: string, conversationId: string, dto: SendMessageDto) {
    const conversation = await this.db.query.conversations.findFirst({
      where: eq(schema.conversations.id, conversationId),
    });

    if (!conversation) {
      throw new NotFoundException('Conversa não encontrada');
    }

    if (conversation.buyerId !== userId && conversation.sellerId !== userId) {
      throw new ForbiddenException('Você não tem acesso a esta conversa');
    }

    // Insert message
    const newMessage = await this.db.insert(schema.messages).values({
      conversationId,
      senderId: userId,
      content: dto.content,
    }).returning();

    // Update conversation updatedAt
    await this.db.update(schema.conversations)
      .set({ updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));

    // Avisa o OUTRO lado da conversa. Quem manda não recebe e-mail do próprio
    // recado; o destinatário é sempre a contraparte.
    this.eventEmitter.emit('message.received', {
      conversationId,
      senderId: userId,
      recipientId:
        conversation.buyerId === userId
          ? conversation.sellerId
          : conversation.buyerId,
      listingId: conversation.listingId ?? null,
      content: dto.content,
    });

    return newMessage[0];
  }

  async markAsRead(userId: string, conversationId: string) {
    const conversation = await this.db.query.conversations.findFirst({
      where: eq(schema.conversations.id, conversationId),
    });

    if (!conversation) {
      throw new NotFoundException('Conversa não encontrada');
    }

    if (conversation.buyerId !== userId && conversation.sellerId !== userId) {
      throw new ForbiddenException('Você não tem acesso a esta conversa');
    }

    await this.db.update(schema.messages)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          ne(schema.messages.senderId, userId),
          isNull(schema.messages.readAt)
        )
      );

    return { success: true };
  }
}
