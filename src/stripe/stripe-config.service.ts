import { Injectable } from '@nestjs/common';

@Injectable()
export class StripeConfigService {
  get secretKey(): string {
    return process.env.STRIPE_SECRET_KEY || '';
  }

  get publishableKey(): string {
    return process.env.STRIPE_PUBLISHABLE_KEY || '';
  }

  get webhookSecret(): string {
    return process.env.STRIPE_WEBHOOK_SECRET || '';
  }

  // Secret para Thin Events V2 (Stripe Connect account updates)
  get thinWebhookSecret(): string {
    return process.env.STRIPE_THIN_WEBHOOK_SECRET || '';
  }
}
