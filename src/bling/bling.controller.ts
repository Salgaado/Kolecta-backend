import {
  Controller,
  Get,
  Delete,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BlingService } from './bling.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('api/bling')
export class BlingController {
  constructor(private readonly blingService: BlingService) {}

  // ── GET /api/bling/status — status da conexão do seller ──────────────────────

  @Get('status')
  @UseGuards(AuthGuard)
  async getStatus(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.blingService.getStatus(userId) };
  }

  // ── GET /api/bling/connect — redireciona para OAuth do Bling ─────────────────

  @Get('connect')
  @UseGuards(AuthGuard)
  connect(@Req() req: Request, @Res() res: Response) {
    const userId = (req as any).auth.userId as string;
    const url = this.blingService.getAuthUrl(userId);
    return res.redirect(url);
  }

  // ── GET /api/bling/callback — recebe o code OAuth e troca por tokens ─────────
  // O state contém o userId definido em getAuthUrl

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:8080';

    if (!code || !state) {
      return res.redirect(`${frontendUrl}/painel/integracoes?bling=error`);
    }

    try {
      await this.blingService.handleCallback(code, state);
      return res.redirect(`${frontendUrl}/painel/integracoes?bling=success`);
    } catch {
      return res.redirect(`${frontendUrl}/painel/integracoes?bling=error`);
    }
  }

  // ── DELETE /api/bling/disconnect — remove a conexão ──────────────────────────

  @Delete('disconnect')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async disconnect(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    await this.blingService.disconnect(userId);
    return { data: { connected: false } };
  }
}
