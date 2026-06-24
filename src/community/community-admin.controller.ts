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
