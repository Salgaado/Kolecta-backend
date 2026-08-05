import {
  Controller,
  Get,
  Delete,
  Logger,
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
  private readonly logger = new Logger(BlingController.name);

  constructor(private readonly blingService: BlingService) {}

  // ── GET /api/bling/status — status da conexão do seller ──────────────────────

  @Get('status')
  @UseGuards(AuthGuard)
  async getStatus(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.blingService.getStatus(userId) };
  }

  // ── GET /api/bling/authorize-url — URL de autorização do Bling ───────────────
  //
  // Devolve a URL em JSON, e NÃO redireciona. O endpoint anterior (`connect`)
  // era um redirect protegido por AuthGuard, e o front mandava o navegador
  // direto nele com `window.location.href`. Navegação de página não carrega
  // cabeçalho `Authorization`, e o cookie de sessão do Clerk mora em
  // kolecta.com.br, não no domínio do backend em onrender.com: o lojista
  // clicava em "Conectar Bling" e recebia um 401 em JSON na cara. Verificado
  // contra a produção em 05/08/2026.
  //
  // Agora o front busca a URL com o Bearer que ele já tem e só então navega.

  @Get('authorize-url')
  @UseGuards(AuthGuard)
  authorizeUrl(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: { url: this.blingService.getAuthUrl(userId) } };
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
    } catch (err: any) {
      // O motivo NÃO pode ir na URL: ela passa pelo navegador do lojista e pelo
      // histórico. Fica no log do servidor, que é onde a gente investiga.
      this.logger.error(
        `Callback do Bling falhou: ${err?.message ?? err}`,
      );
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
