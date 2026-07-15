import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { FounderService } from './founder.service';
import { RedeemInviteDto } from './dto/redeem-invite.dto';
import { UseCreditDto } from './dto/use-credit.dto';

@Controller('api/founder')
export class FounderController {
  constructor(private readonly founderService: FounderService) {}

  /** Estado do programa para o usuário logado (avalia qualificação na leitura). */
  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Req() req: Request) {
    const userId = (req as any).auth.userId;
    return this.founderService.getMyStatus(userId);
  }

  /** Resgata um código de convite do evento presencial (faixa #001–#050). */
  @Post('redeem')
  @UseGuards(AuthGuard)
  async redeem(@Req() req: Request, @Body() dto: RedeemInviteDto) {
    const userId = (req as any).auth.userId;
    return this.founderService.redeemInviteCode(userId, dto.code);
  }

  /** Consome 1 crédito de destaque colocando um anúncio do fundador em destaque. */
  @Post('credits/use')
  @UseGuards(AuthGuard)
  async useCredit(@Req() req: Request, @Body() dto: UseCreditDto) {
    const userId = (req as any).auth.userId;
    return this.founderService.useCredit(userId, dto.listingId);
  }

  /** Selo público de um usuário (para render no card/perfil). null se não é fundador. */
  @Get(':userId/badge')
  async badge(@Param('userId') userId: string) {
    const badge = await this.founderService.getPublicBadge(userId);
    return { data: badge };
  }
}
