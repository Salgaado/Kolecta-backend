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
@Roles('user', 'admin') // Somente usuários autenticados e com role
@Controller('api/messages/conversations')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  async getConversations(@Req() req: Request) {
    const userId = (req as any).user?.id;
    return this.messagesService.getConversations(userId);
  }

  @Get(':id')
  async getConversation(@Param('id') id: string, @Req() req: Request) {
    const userId = (req as any).user?.id;
    return this.messagesService.getConversation(id, userId);
  }

  @Post()
  async startConversation(
    @Body() dto: StartConversationDto,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id;
    return this.messagesService.startConversation(userId, dto);
  }

  @Post(':id')
  async sendMessage(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id;
    return this.messagesService.sendMessage(userId, id, dto);
  }

  @Patch(':id/read')
  async markAsRead(@Param('id') id: string, @Req() req: Request) {
    const userId = (req as any).user?.id;
    return this.messagesService.markAsRead(userId, id);
  }
}
