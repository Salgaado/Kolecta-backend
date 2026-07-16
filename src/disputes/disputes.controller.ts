import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { DisputesService } from './disputes.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AddDisputeMessageDto, CreateDisputeDto } from './dto/dispute.dto';

@Controller('api/disputes')
@UseGuards(AuthGuard, RolesGuard)
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Get()
  @Roles('user', 'admin')
  async list(@Req() req: any) {
    const data = await this.disputesService.findMine(req.auth.userId);
    return { data };
  }

  @Get('eligible-orders')
  @Roles('user', 'admin')
  async eligibleOrders(@Req() req: any) {
    const data = await this.disputesService.eligibleOrders(req.auth.userId);
    return { data };
  }

  @Get(':id')
  @Roles('user', 'admin')
  async detail(@Req() req: any, @Param('id') id: string) {
    const data = await this.disputesService.findOne(req.auth.userId, id);
    return { data };
  }

  @Post()
  @Roles('user', 'admin')
  async create(@Req() req: any, @Body() dto: CreateDisputeDto) {
    const data = await this.disputesService.create(req.auth.userId, dto);
    return { data };
  }

  @Post(':id/messages')
  @Roles('user', 'admin')
  async addMessage(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: AddDisputeMessageDto,
  ) {
    const data = await this.disputesService.addMessage(
      req.auth.userId,
      id,
      dto.content,
    );
    return { data };
  }
}
