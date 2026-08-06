import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { TrackEventsDto } from './dto/track-events.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  // ── POST /api/analytics/events — ingest público (visitante anônimo) ──────
  // Sem auth de propósito: o visitante não logado também gera funil. Aceita
  // lote pequeno (o cliente agrupa antes de mandar).
  @Post('api/analytics/events')
  @HttpCode(HttpStatus.OK)
  async ingest(@Body() dto: TrackEventsDto) {
    return this.analytics.ingest(dto.events ?? []);
  }

  // ── GET /api/admin/analytics/traffic — funil agregado (admin) ────────────
  @Get('api/admin/analytics/traffic')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  async traffic(@Query('days') days?: string) {
    return { data: await this.analytics.getTraffic(days ? Number(days) : 7) };
  }
}
