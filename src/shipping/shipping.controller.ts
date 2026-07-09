import { Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { ShippingService } from './shipping.service';
import { QuoteShippingDto, GenerateLabelDto } from './dto/shipping.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('api/shipping')
export class ShippingController {
  constructor(private readonly shippingService: ShippingService) {}

  // Cotação é aberta (só estima preço; usada no checkout sem token).
  @Post('quote')
  async quote(@Body() dto: QuoteShippingDto) {
    return this.shippingService.quoteShipping(dto);
  }

  // Etiqueta é uma ação: exige auth e que o vendedor seja o dono do pedido.
  @Post('label')
  @UseGuards(AuthGuard)
  async generateLabel(@Req() req: any, @Body() dto: GenerateLabelDto) {
    return this.shippingService.generateLabel(dto, req.auth.userId);
  }
}
