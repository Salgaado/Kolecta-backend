import { Injectable } from '@nestjs/common';

@Injectable()
export class StripeConfigService {
  get secretKey(): string {
    return process.env.STRIPE_SECRET_KEY || '';
  }

  get webhookSecret(): string {
    return process.env.STRIPE_WEBHOOK_SECRET || '';
  }
}
