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
import { TinyService } from './tiny.service';
import { AuthGuard } from '../auth/auth.guard';

/**
 * Conexão do vendedor com o Tiny (Olist ERP).
 *
 * Só a CONEXÃO. Catálogo, importação, estoque e pedido de venda são as fases
 * 2 a 4 do docs/PLAN-tiny-olist.md e dependem de ver o dado real — o formato de
 * peso, dimensão e foto do Tiny ainda não foi medido contra uma conta de
 * verdade, e chutar isso no Bling já cotou frete de uma caixa cem vezes maior.
 */
@Controller('api/tiny')
export class TinyController {
  private readonly logger = new Logger(TinyController.name);

  constructor(private readonly tiny: TinyService) {}

  // ── GET /api/tiny/status — status da conexão do seller ──────────────────────

  @Get('status')
  @UseGuards(AuthGuard)
  async getStatus(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.tiny.getStatus(userId) };
  }

  // ── GET /api/tiny/authorize-url — URL de autorização do Tiny ────────────────
  //
  // Devolve a URL em JSON, e NÃO redireciona. É a lição do Bling: um redirect
  // protegido por AuthGuard não funciona, porque o front manda o navegador
  // direto nele com `window.location.href`, navegação de página não carrega
  // cabeçalho `Authorization`, e o cookie de sessão do Clerk mora em
  // kolecta.com.br, não no domínio do backend em onrender.com. O lojista
  // clicava em "Conectar" e recebia um 401 em JSON na cara.

  @Get('authorize-url')
  @UseGuards(AuthGuard)
  authorizeUrl(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: { url: this.tiny.getAuthUrl(userId) } };
  }

  // ── GET /api/tiny/callback — recebe o code OAuth e troca por tokens ─────────
  // O `state` é assinado (ver TinyService.assinarState) e diz de quem é a conexão

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:8080';

    if (!code || !state) {
      return res.redirect(`${frontendUrl}/painel/integracoes?tiny=error`);
    }

    try {
      await this.tiny.handleCallback(code, state);
      return res.redirect(`${frontendUrl}/painel/integracoes?tiny=success`);
    } catch (err: any) {
      // O motivo NÃO pode ir na URL: ela passa pelo navegador do lojista e pelo
      // histórico. Fica no log do servidor, que é onde a gente investiga.
      this.logger.error(`Callback do Tiny falhou: ${err?.message ?? err}`);
      return res.redirect(`${frontendUrl}/painel/integracoes?tiny=error`);
    }
  }

  // ── GET /api/tiny/verificar — prova de vida da conexão ──────────────────────
  //
  // Chama `GET /info` no ERP do lojista. Existe porque "conectado" no nosso
  // banco não prova que uma chamada de DADO passa: no Bling, o OAuth funcionava
  // e todas as chamadas de dado voltavam 403 por causa do host errado, e a
  // integração ficou "conectada" e inútil em duas lojas até alguém conferir.

  @Get('verificar')
  @UseGuards(AuthGuard)
  async verificar(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.tiny.verificarConexao(userId) };
  }

  // ── DELETE /api/tiny/disconnect — remove a conexão ──────────────────────────

  @Delete('disconnect')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async disconnect(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    await this.tiny.disconnect(userId);
    return { data: { connected: false } };
  }
}
