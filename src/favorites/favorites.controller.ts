import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { FavoritesService } from './favorites.service';

@Controller('api/favorites')
@UseGuards(AuthGuard)
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Get()
  async findAll(@Req() req: Request) {
    const userId = (req as any).auth.userId;
    const favorites = await this.favoritesService.findAll(userId);
    return { data: favorites };
  }

  @Post()
  async toggle(@Req() req: Request, @Body('listingId') listingId: string) {
    const userId = (req as any).auth.userId;
    return this.favoritesService.toggle(userId, listingId);
  }

  @Delete(':listingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param('listingId') listingId: string) {
    const userId = (req as any).auth.userId;
    await this.favoritesService.remove(userId, listingId);
  }
}
