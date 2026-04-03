import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { FavoritesService } from './favorites.service';
import { CreateFavoriteDto } from './dto/favorite.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('api/favorites')
@UseGuards(AuthGuard)
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  // ── GET /api/favorites — Lista favoritos do usuário ──────────────────────

  @Get()
  async findAll(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    const favorites = await this.favoritesService.findAll(userId);
    return { data: favorites };
  }

  // ── POST /api/favorites — Toggle favorito (adiciona ou remove) ───────────

  @Post()
  async toggle(@Req() req: Request, @Body() dto: CreateFavoriteDto) {
    const userId = (req as any).auth.userId as string;
    const result = await this.favoritesService.toggle(userId, dto.listingId);
    return result;
  }

  // ── DELETE /api/favorites/:listingId — Remove favorito específico ─────────

  @Delete(':listingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param('listingId') listingId: string) {
    const userId = (req as any).auth.userId as string;
    await this.favoritesService.remove(userId, listingId);
  }
}
