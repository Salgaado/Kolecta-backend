import { Controller, Post, Body, Req } from '@nestjs/common';
import { DepositsService } from './deposits.service';

@Controller('deposits')
export class DepositsController {
  constructor(private readonly depositsService: DepositsService) {}

  @Post('checkout-session')
  async createCheckoutSession(
    @Body() body: { orderId: string; amountInCents: number; buyerEmail?: string },
    @Req() req: any,
  ) {
    if (!body.orderId || !body.amountInCents) {
      throw new Error('orderId and amountInCents are required');
    }

    return this.depositsService.createCheckoutSession(
      body.orderId,
      body.amountInCents,
      body.buyerEmail,
    );
  }
}
