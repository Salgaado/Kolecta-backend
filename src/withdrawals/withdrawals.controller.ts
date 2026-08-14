import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { WithdrawalsService } from './withdrawals.service';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/withdrawals')
@UseGuards(AuthGuard, RolesGuard)
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  // ── GET /api/withdrawals/me — Histórico de saques do seller ─────────────

  @Get('me')
  @Roles('user', 'admin')
  async findMine(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    const withdrawals = await this.withdrawalsService.findMyWithdrawals(userId);
    return { data: withdrawals };
  }

  // ── GET /api/withdrawals/limits — Quanto dá para sacar de verdade ────────

  /**
   * Mínimo, taxa e MÁXIMO REAL do saque.
   *
   * Existe porque o front não tem como calcular isso: o teto não é o saldo da
   * carteira, é o saldo menos a taxa da Pagar.me — e, quando a consulta de
   * saldo responde, limitado também pelo disponível real do recebedor.
   */
  @Get('limits')
  @Roles('user', 'admin')
  async limits(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.withdrawalsService.getLimits(userId) };
  }

  // ── POST /api/withdrawals — Solicitar saque ──────────────────────────────

  @Post()
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.CREATED)
  async request(@Req() req: Request, @Body() dto: RequestWithdrawalDto) {
    const userId = (req as any).auth.userId as string;
    const withdrawal = await this.withdrawalsService.requestWithdrawal(
      userId,
      dto,
    );
    return { data: withdrawal };
  }
}
