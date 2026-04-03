import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { AddressesService } from './addresses.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('api/addresses')
@UseGuards(AuthGuard)
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  // ── GET /api/addresses — Lista endereços do usuário autenticado ──────────

  @Get()
  async findAll(@Req() req: Request) {
    const userId = (req as any).auth.userId as string;
    const addresses = await this.addressesService.findAll(userId);
    return { data: addresses };
  }

  // ── POST /api/addresses — Cria novo endereço ─────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: Request, @Body() dto: CreateAddressDto) {
    const userId = (req as any).auth.userId as string;
    const address = await this.addressesService.create(userId, dto);
    return { data: address };
  }

  // ── PATCH /api/addresses/:id — Atualiza endereço ─────────────────────────

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    const userId = (req as any).auth.userId as string;
    const address = await this.addressesService.update(userId, id, dto);
    return { data: address };
  }

  // ── DELETE /api/addresses/:id — Remove endereço ──────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param('id') id: string) {
    const userId = (req as any).auth.userId as string;
    await this.addressesService.remove(userId, id);
  }
}
