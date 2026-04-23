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
    const buyerId = req.auth.userId;
    return this.ordersService.createOrders(buyerId, createOrderDto);
  }

  @Post('checkout')
  @Roles('user', 'admin')
  async createCheckout(@Req() req: any, @Body() dto: CreateOrderDto) {
    return this.ordersService.createOrderWithPaymentIntent(
      req.auth.userId,
      dto,
    );
  }

  @Get('my/purchases')
  @Roles('user', 'admin')
  async getBuyerOrders(@Req() req: any) {
    const orders = await this.ordersService.findBuyerOrders(req.auth.userId);
    return { data: orders };
  }

  @Get('my/sales')
  @Roles('user', 'admin')
  async getSellerOrders(@Req() req: any) {
    const orders = await this.ordersService.findSellerOrders(req.auth.userId);
    return { data: orders };
  }

  @Get(':id')
  @Roles('user', 'admin')
  async getOrderById(@Req() req: any, @Param('id') id: string) {
    const order = await this.ordersService.findById(id, req.auth.userId);
    return { data: order };
  }

  @Patch(':id/status')
  @Roles('user', 'admin')
  async updateStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    const order = await this.ordersService.updateOrderStatus(
      req.auth.userId,
      id,
      dto,
    );
    return { data: order };
  }
}
