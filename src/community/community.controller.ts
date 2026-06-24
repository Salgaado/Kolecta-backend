import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CommunityService } from './community.service';
import type { FeedSort } from './community.service';
import {
  CreatePostDto,
  UpdatePostDto,
  CreateCommentDto,
  CreateReportDto,
} from './dto/community.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

const userId = (req: Request) => (req as any).auth.userId as string;

@Controller('api/community')
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  // ── Leitura (pública) ────────────────────────────────────────────────────────

  @Get('feed')
  async feed(
    @Query('sort') sort?: FeedSort,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('categoryId') categoryId?: string,
    @Query('type') type?: string,
  ) {
    return this.community.getFeed({
      sort,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      categoryId,
      type,
    });
  }

  @Get('highlights')
  async highlights() {
    return { data: await this.community.getHighlights() };
  }

  @Get('trends')
  async trends(@Query('window') window?: '24h' | '7d' | 'month') {
    return { data: await this.community.getTrends(window ?? '24h') };
  }

  @Get('posts/:id')
  async getPost(@Param('id') id: string) {
    return { data: await this.community.getPost(id) };
  }

  @Get('posts/:id/comments')
  async getComments(@Param('id') id: string) {
    return { data: await this.community.getComments(id) };
  }

  // ── Escrita (autenticado) ────────────────────────────────────────────────────

  @Post('posts')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async create(@Body() dto: CreatePostDto, @Req() req: Request) {
    return { data: await this.community.createPost(userId(req), dto) };
  }

  @Patch('posts/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePostDto,
    @Req() req: Request,
  ) {
    return { data: await this.community.updatePost(userId(req), id, dto) };
  }

  @Delete('posts/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async remove(@Param('id') id: string, @Req() req: Request) {
    return this.community.deletePost(userId(req), id);
  }

  @Post('posts/:id/like')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async like(@Param('id') id: string, @Req() req: Request) {
    return { data: await this.community.toggleLike(userId(req), id) };
  }

  @Post('posts/:id/save')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async save(@Param('id') id: string, @Req() req: Request) {
    return { data: await this.community.toggleSave(userId(req), id) };
  }

  @Post('posts/:id/pin')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async pin(@Param('id') id: string, @Req() req: Request) {
    return { data: await this.community.togglePin(userId(req), id) };
  }

  @Post('posts/:id/comments')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async comment(
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
    @Req() req: Request,
  ) {
    return { data: await this.community.addComment(userId(req), id, dto) };
  }

  @Post('reports')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  async report(@Body() dto: CreateReportDto, @Req() req: Request) {
    return { data: await this.community.createReport(userId(req), dto) };
  }
}
