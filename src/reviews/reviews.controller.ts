import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/review.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@UseGuards(AuthGuard, RolesGuard)
@Roles('user', 'admin')
@Controller('api/reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // ── POST /api/reviews — criar avaliação (requer transação concluída) ─────────

  @Post()
  async create(@Body() dto: CreateReviewDto, @Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.reviewsService.createReview(userId, dto) };
  }

  // ── GET /api/reviews/received — avaliações recebidas pelo usuário ────────────

  @Get('received')
  async received(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.reviewsService.getReceived(userId) };
  }

  // ── GET /api/reviews/given — avaliações feitas pelo usuário ──────────────────

  @Get('given')
  async given(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    return { data: await this.reviewsService.getGiven(userId) };
  }
}
