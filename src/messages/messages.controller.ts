import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { MessagesService } from './messages.service';
import { StartConversationDto, SendMessageDto } from './dto/messages.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@UseGuards(AuthGuard, RolesGuard)
@Roles('user', 'admin')
@Controller('api/messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  // ── GET /api/messages/conversations ──────────────────────────────────────────

  @Get('conversations')
  async getConversations(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return this.messagesService.getConversations(userId);
  }

  // ── GET /api/messages/conversations/:id ──────────────────────────────────────

  @Get('conversations/:id')
  async getConversation(@Param('id') id: string, @Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.messagesService.getConversation(id, userId) };
  }

  // ── POST /api/messages/conversations — iniciar conversa (requer transação) ───

  @Post('conversations')
  async startConversation(@Body() dto: StartConversationDto, @Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.messagesService.startConversation(userId, dto) };
  }

  // ── POST /api/messages/from-order/:orderId — abrir/criar chat pelo pedido ────

  @Post('from-order/:orderId')
  async startFromOrder(@Param('orderId') orderId: string, @Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.messagesService.startFromOrder(userId, orderId) };
  }

  // ── POST /api/messages/conversations/:id — enviar mensagem ───────────────────

  @Post('conversations/:id')
  async sendMessage(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @Req() req: Request,
  ) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.messagesService.sendMessage(userId, id, dto) };
  }

  // ── PATCH /api/messages/conversations/:id/read ───────────────────────────────

  @Patch('conversations/:id/read')
  async markAsRead(@Param('id') id: string, @Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return this.messagesService.markAsRead(userId, id);
  }
}
