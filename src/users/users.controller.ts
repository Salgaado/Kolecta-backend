import {
  Controller,
  Get,
  Patch,
  Body,
  Req,
  UseGuards,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { UsersService } from './users.service';
import type { UpdateUserDto } from './users.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('api/users')
@UseGuards(AuthGuard)
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(private readonly usersService: UsersService) {}

  /**
   * GET /api/users/me
   * Retorna o perfil completo do usuário autenticado (dados do Turso).
   */
  @Get('me')
  async getMe(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    this.logger.log(`[GET /me] userId: ${userId}`);
    const user = await this.usersService.findOrCreate(userId);
    return { data: user };
  }

  /**
   * PATCH /api/users/me
   * Atualiza o perfil do usuário autenticado (name, role).
   */
  @Patch('me')
  @HttpCode(HttpStatus.OK)
  async updateMe(@Req() req: Request, @Body() dto: UpdateUserDto) {
    const userId = (req as any).auth.userId as string;
    this.logger.log(`[PATCH /me] userId: ${userId}`);
    const user = await this.usersService.update(userId, dto);
    return { data: user };
  }
}
