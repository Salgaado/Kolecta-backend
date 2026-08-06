import {
  Body,
  Controller,
  Get,
  Post,
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
import { BlingImportService } from './bling-import.service';
import { BlingEstoqueService } from './bling-estoque.service';
import { ImportarBlingDto } from './dto/bling.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('api/bling')
export class BlingController {
  private readonly logger = new Logger(BlingController.name);

  constructor(
    private readonly blingService: BlingService,
    private readonly importService: BlingImportService,
    private readonly estoqueService: BlingEstoqueService,
  ) {}

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

  // ── GET /api/bling/produtos — catálogo do lojista, uma página ────────────────
  //
  // Listagem barata: sem peso, dimensões nem GTIN, que só existem no detalhe.
  // Buscar detalhe de tudo aqui custaria uma requisição por produto para encher
  // uma tela que o lojista talvez nem role até o fim.

  @Get('produtos')
  @UseGuards(AuthGuard)
  async produtos(@Req() req: Request, @Query('pagina') pagina?: string) {
    const userId = (req as any).auth.userId as string;
    const n = Math.max(1, parseInt(pagina ?? '1', 10) || 1);
    return { data: await this.blingService.listarProdutos(userId, n) };
  }

  // ── POST /api/bling/conferir — o que falta, SEM criar nada ───────────────────

  @Post('conferir')
  @UseGuards(AuthGuard)
  async conferir(@Req() req: Request, @Body() dto: ImportarBlingDto) {
    const userId = (req as any).auth.userId as string;
    return {
      data: await this.importService.conferir(userId, dto.ids, {
        categoria: dto.categoria,
        condicao: dto.condicao,
        atributos: dto.atributos,
      }),
    };
  }

  // ── POST /api/bling/importar — cria os anúncios que passam ───────────────────

  @Post('importar')
  @UseGuards(AuthGuard)
  async importar(@Req() req: Request, @Body() dto: ImportarBlingDto) {
    const userId = (req as any).auth.userId as string;
    return {
      data: await this.importService.importar(userId, dto.ids, {
        categoria: dto.categoria,
        condicao: dto.condicao,
        atributos: dto.atributos,
      }),
    };
  }

  // ── POST /api/bling/estoque/sincronizar: puxa o saldo do ERP agora ───────────
  //
  // O cron já roda de meia em meia hora. Este endpoint existe para o lojista que
  // acabou de mexer no estoque e quer ver a vitrine acertada agora, sem esperar
  // a próxima rodada e sem ficar na dúvida se a integração está viva.

  @Post('estoque/sincronizar')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async sincronizarEstoque(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.estoqueService.sincronizar(userId) };
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
