import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ShippingService } from './shipping.service';
import { QuoteShippingDto, GenerateLabelDto } from './dto/shipping.dto';

@Controller('api/shipping')
export class ShippingController {
  constructor(private readonly shippingService: ShippingService) {}

  @Post('quote')
  async quote(@Body() dto: QuoteShippingDto) {
    return this.shippingService.quoteShipping(dto);
  }

  @Post('label')
  async generateLabel(@Body() dto: GenerateLabelDto) {
    return this.shippingService.generateLabel(dto.order_id);
  }
}
