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
} from '@nestjs/common';
import type { Request } from 'express';
import { CommunityService } from './community.service';
import { BanUserDto } from './dto/community.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@UseGuards(AuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/community/admin')
export class CommunityAdminController {
  constructor(private readonly community: CommunityService) {}

  @Get('reports')
  async reports(@Query('status') status?: string) {
    return { data: await this.community.listReports(status ?? 'open') };
  }

  @Patch('posts/:id/hide')
  async hide(@Param('id') id: string) {
    return this.community.setPostStatus(id, 'hidden');
  }

  @Patch('posts/:id/remove')
  async remove(@Param('id') id: string) {
    return this.community.setPostStatus(id, 'removed');
  }

  @Patch('posts/:id/restore')
  async restore(@Param('id') id: string) {
    return this.community.setPostStatus(id, 'active');
  }

  // ── Comentários ────────────────────────────────────────────────────────────
  //
  // A coluna `status` existia em `community_comments` desde sempre, mas só post
  // tinha endpoint. Descoberto com spam de concorrente em 3 dos 9 comentários
  // da comunidade, sem nenhuma forma de tirar do ar.

  @Patch('comments/:id/hide')
  async hideComment(@Param('id') id: string) {
    return this.community.setCommentStatus(id, 'hidden');
  }

  @Patch('comments/:id/remove')
  async removeComment(@Param('id') id: string) {
    return this.community.setCommentStatus(id, 'removed');
  }

  @Patch('comments/:id/restore')
  async restoreComment(@Param('id') id: string) {
    return this.community.setCommentStatus(id, 'active');
  }

  // ── Fila de moderação ──────────────────────────────────────────────────────
  //
  // Posts e comentários juntos, inclusive os já ocultos: a listagem pública
  // esconde o que não está `active`, então sem isto não há como achar o que
  // moderar nem desfazer o que foi ocultado.

  @Get('conteudo')
  async conteudo(@Query('status') status?: string) {
    return { data: await this.community.listarParaModeracao(status) };
  }

  @Post('ban')
  async ban(@Body() dto: BanUserDto, @Req() req: Request) {
    const adminId = (req as any).auth.userId as string;
    return this.community.banUser(adminId, dto.userId, dto.reason);
  }

  @Post('unban')
  async unban(@Body() dto: BanUserDto) {
    return this.community.unbanUser(dto.userId);
  }
}
