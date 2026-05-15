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

@Injectable()
export class MessagesService {
  constructor(
    @Inject(DATABASE_CONNECTION) private db: LibSQLDatabase<typeof schema>,
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

    // Check if conversation already exists
    const existing = await this.db.query.conversations.findFirst({
      where: and(
        eq(schema.conversations.listingId, dto.listingId),
        eq(schema.conversations.buyerId, userId),
      ),
    });

    if (existing) {
      // Just add message to existing
      const msg = await this.sendMessage(userId, existing.id, { content: dto.message });
      return { conversationId: existing.id, message: msg };
    }

    // Create new conversation
    const newConv = await this.db.insert(schema.conversations).values({
      listingId: dto.listingId,
      buyerId: userId,
      sellerId: listing.sellerId,
    }).returning();

    const conversationId = newConv[0].id;

    // Create initial message
    const newMessage = await this.db.insert(schema.messages).values({
      conversationId,
      senderId: userId,
      content: dto.message,
    }).returning();

    return {
      conversationId,
      message: newMessage[0],
    };
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
