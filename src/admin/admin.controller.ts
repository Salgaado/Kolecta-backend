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
} from './dto/admin.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ── GET /api/admin/stats ─────────────────────────────────────────────────

  @Get('stats')
  async getStats() {
    return { data: await this.adminService.getStats() };
  }

  // ── POST /api/admin/test-email ───────────────────────────────────────────
  // Valida a config de e-mail do ambiente sem esperar uma venda real.
  // Ex: { "to": "voce@exemplo.com" } → devolve sent | skipped | failed.

  @Post('test-email')
  @HttpCode(HttpStatus.OK)
  async sendTestEmail(@Body() dto: SendTestEmailDto) {
    return { data: await this.adminService.sendTestEmail(dto) };
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
  async updateUserRole(@Param('id') id: string, @Body() dto: UpdateUserRoleDto) {
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
  async resolveDispute(@Param('id') id: string, @Body() dto: ResolveDisputeDto) {
    return { data: await this.adminService.resolveDispute(id, dto) };
  }

  // ── GET /api/admin/listings ──────────────────────────────────────────────

  @Get('listings')
  async listListings(
    @Query('status') status?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
  ) {
    return { data: await this.adminService.listListings(status, limit, offset) };
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
