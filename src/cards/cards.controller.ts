import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CardsService } from './cards.service';
import { SaveCardDto } from './dto/save-card.dto';

@Controller('api/cards')
@UseGuards(AuthGuard)
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  /** Cartão salvo do usuário (mascarado) — { data: card | null }. */
  @Get()
  async getCard(@Req() req: Request) {
    const userId = (req as any).auth.userId;
    const card = await this.cardsService.getSavedCard(userId);
    return { data: card };
  }

  /** Salva/substitui o cartão a partir de um card_token tokenizado no front. */
  @Post()
  async saveCard(@Req() req: Request, @Body() dto: SaveCardDto) {
    const userId = (req as any).auth.userId;
    const card = await this.cardsService.saveCard(userId, dto.cardToken);
    return { data: card };
  }

  /** Remove o cartão salvo. */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCard(@Req() req: Request) {
    const userId = (req as any).auth.userId;
    await this.cardsService.removeCard(userId);
  }
}
