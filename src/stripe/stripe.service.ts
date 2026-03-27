import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeConfigService } from './stripe-config.service';

@Injectable()
export class StripeService {
  public readonly stripe: Stripe;

  constructor(private readonly configService: StripeConfigService) {
    this.stripe = new Stripe(this.configService.secretKey, {
      apiVersion: '2026-03-25.dahlia', // explicitly typed for this sdk version
    });
  }

  constructEvent(payload: string | Buffer, signature: string) {
    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.configService.webhookSecret,
    );
  }
}
