import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminService } from './admin.service';
import {
  UpdateUserRoleDto,
  ResolveDisputeDto,
  SendTestEmailDto,
  BroadcastDto,
  ConciliarOrderDto,
} from './dto/admin.dto';
import { BroadcastService } from '../notifications/broadcast.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ConciliacaoService } from '../pagarme/conciliacao.service';

@Controller('api/admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly broadcast: BroadcastService,
    private readonly conciliacaoService: ConciliacaoService,
  ) {}

  // ── GET /api/admin/stats ─────────────────────────────────────────────────

  @Get('stats')
  async getStats() {
    return { data: await this.adminService.getStats() };
  }

  // ── GET /api/admin/orders — lista de pedidos (abrir a venda) ─────────────

  @Get('orders')
  async getOrders(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.adminService.getOrders({
      status: status?.trim() || undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  // ── GET /api/admin/orders/:id — detalhe da venda (etiqueta/declaração) ───

  @Get('orders/:id')
  async getOrderDetail(@Param('id') id: string) {
    return { data: await this.adminService.getOrderDetail(id) };
  }

  // ── POST /api/admin/orders/:id/conciliar ─────────────────────────────────
  // Pergunta à Pagar.me o estado REAL do pedido e conserta o nosso lado se
  // divergir. Escape manual enquanto o cron de conciliação não roda sozinho —
  // e o caminho usado quando o webhook falha de um jeito que não dá para
  // reenviar (o de 12/08 foi engolido pela nossa própria idempotência).
  //
  // Sem `pagarmeOrderId` usa a referência do banco; informe-a quando ela for
  // nula — é o caso de cobrança recusada, em que o id era descartado.
  //
  //   { "pagarmeOrderId": "or_XXXXXXXX" }

  @Post('orders/:id/conciliar')
  @HttpCode(HttpStatus.OK)
  async conciliarOrder(
    @Param('id') id: string,
    @Body() dto: ConciliarOrderDto,
  ) {
    return {
      data: await this.conciliacaoService.conciliarPedido(
        id,
        dto?.pagarmeOrderId,
      ),
    };
  }

  // ── POST /api/admin/charges/:chargeId/liberar-retencao ───────────────────
  // Cancela uma pré-autorização não capturada e devolve o limite ao comprador
  // na hora. Para as retenções que ficaram de pé antes da correção da ordem
  // (a auth era lida depois da consolidação e o cancelamento nunca rodava).
  //
  // Recusa qualquer cobrança que não esteja em `authorized_pending_capture`:
  // numa cobrança PAGA o mesmo DELETE seria um ESTORNO.

  @Post('charges/:chargeId/liberar-retencao')
  @HttpCode(HttpStatus.OK)
  async liberarRetencao(@Param('chargeId') chargeId: string) {
    return { data: await this.conciliacaoService.liberarRetencao(chargeId) };
  }

  // ── POST /api/admin/test-email ───────────────────────────────────────────
  // Valida a config de e-mail do ambiente sem esperar uma venda real.
  // Ex: { "to": "voce@exemplo.com" } → devolve sent | skipped | failed.

  @Post('test-email')
  @HttpCode(HttpStatus.OK)
  async sendTestEmail(@Body() dto: SendTestEmailDto) {
    return { data: await this.adminService.sendTestEmail(dto) };
  }

  // ── POST /api/admin/broadcast ────────────────────────────────────────────
  // Comunicado para toda a base. ENSAIO por padrão: sem `dryRun:false` no
  // corpo, devolve só a contagem de destinatários e não envia nada.
  //
  //   ensaio : { "template":"aviso-pagamento", "campanha":"aviso-pagamento-2026-07-30" }
  //   teste  : { ..., "dryRun":false, "apenasPara":"voce@exemplo.com" }
  //   valendo: { ..., "dryRun":false }

  @Post('broadcast')
  @HttpCode(HttpStatus.OK)
  async sendBroadcast(@Body() dto: BroadcastDto) {
    return { data: await this.broadcast.enviar(dto) };
  }

  // ── Agregações (dashboards) ──────────────────────────────────────────────

  @Get('overview')
  async getOverview() {
    return { data: await this.adminService.getOverview() };
  }

  @Get('reports')
  async getReports() {
    return { data: await this.adminService.getReports() };
  }

  @Get('financial')
  async getFinancial() {
    return { data: await this.adminService.getFinancial() };
  }

  @Get('auctions')
  async getAuctionsMonitor() {
    return { data: await this.adminService.getAuctionsMonitor() };
  }

  @Get('sellers/detailed')
  async listSellersDetailed() {
    return { data: await this.adminService.listSellersDetailed() };
  }

  // ── GET /api/admin/users ─────────────────────────────────────────────────

  @Get('users')
  async listUsers(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return { data: await this.adminService.listUsers(limit, offset) };
  }

  // ── PATCH /api/admin/users/:id/role ─────────────────────────────────────

  @Patch('users/:id/role')
  @HttpCode(HttpStatus.OK)
  async updateUserRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return { data: await this.adminService.updateUserRole(id, dto) };
  }

  // ── GET /api/admin/sellers ───────────────────────────────────────────────

  @Get('sellers')
  async listSellers(@Query('verified') verified?: string) {
    const filter =
      verified === 'true' ? true : verified === 'false' ? false : undefined;
    return { data: await this.adminService.listSellers(filter) };
  }

  // ── PATCH /api/admin/sellers/:id/verify ─────────────────────────────────

  @Patch('sellers/:id/verify')
  @HttpCode(HttpStatus.OK)
  async verifySeller(
    @Param('id') id: string,
    @Body('verified') verified: boolean,
  ) {
    return { data: await this.adminService.verifySeller(id, verified) };
  }

  // ── GET /api/admin/disputes ──────────────────────────────────────────────

  @Get('disputes')
  async listDisputes(@Query('status') status?: string) {
    return { data: await this.adminService.listDisputes(status) };
  }

  // ── PATCH /api/admin/disputes/:id ───────────────────────────────────────

  @Patch('disputes/:id')
  @HttpCode(HttpStatus.OK)
  async resolveDispute(
    @Param('id') id: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return { data: await this.adminService.resolveDispute(id, dto) };
  }

  // ── GET /api/admin/listings ──────────────────────────────────────────────

  @Get('listings')
  async listListings(
    @Query('status') status?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
  ) {
    return {
      data: await this.adminService.listListings(status, limit, offset),
    };
  }

  // ── PATCH /api/admin/listings/:id/status ────────────────────────────────

  @Patch('listings/:id/status')
  @HttpCode(HttpStatus.OK)
  async updateListingStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body('status') status: string,
    @Body('reason') reason?: string,
  ) {
    const moderatorId = (req as any).auth?.userId as string | undefined;
    return {
      data: await this.adminService.updateListingStatus(id, status, {
        reason,
        moderatorId,
      }),
    };
  }

  // ── Programa Fundador — concessão pela equipe ────────────────────────────

  // GET /api/admin/founders/candidates — fila de candidatos + próximo nº livre
  @Get('founders/candidates')
  async listFounderCandidates() {
    return { data: await this.adminService.listFounderCandidates() };
  }

  // POST /api/admin/founders/:userId/grant — concede o selo com número manual
  @Post('founders/:userId/grant')
  @HttpCode(HttpStatus.OK)
  async grantFounder(
    @Param('userId') userId: string,
    @Body('number', ParseIntPipe) founderNumber: number,
  ) {
    return {
      data: await this.adminService.grantFounder(userId, founderNumber),
    };
  }
}
