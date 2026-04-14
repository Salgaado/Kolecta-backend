import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderStatusDto } from './dto/create-order.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/orders')
@UseGuards(AuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @Roles('user', 'admin')
  async createOrder(@Req() req: any, @Body() createOrderDto: CreateOrderDto) {
    const buyerId = req.user.id;
    return this.ordersService.createOrders(buyerId, createOrderDto);
  }

  @Post('checkout')
  @Roles('user', 'admin')
  async createCheckout(@Req() req: any, @Body() dto: CreateOrderDto) {
    return this.ordersService.createOrderWithPaymentIntent(req.user.id, dto);
  }

  @Get('my/purchases')
  @Roles('user', 'admin')
  async getBuyerOrders(@Req() req: any) {
    return this.ordersService.findBuyerOrders(req.user.id);
  }

  @Get('my/sales')
  @Roles('user', 'admin')
  async getSellerOrders(@Req() req: any) {
    return this.ordersService.findSellerOrders(req.user.id);
  }

  @Get(':id')
  @Roles('user', 'admin')
  async getOrderById(@Req() req: any, @Param('id') id: string) {
    return this.ordersService.findById(id, req.auth?.userId ?? req.user?.id);
  }

  @Patch(':id/status')
  @Roles('user', 'admin')
  async updateStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateOrderStatus(req.user.id, id, dto);
  }
}
