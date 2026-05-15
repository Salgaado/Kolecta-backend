import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeConfigService } from './stripe-config.service';

@Injectable()
export class StripeService {
  // Stripe Client pattern — instância única reutilizada em toda a aplicação
  public readonly stripeClient: InstanceType<typeof Stripe>;

  constructor(private readonly configService: StripeConfigService) {
    if (!this.configService.secretKey) {
      throw new Error(
        '❌ STRIPE_SECRET_KEY não está definida. Verifique seu arquivo .env',
      );
    }
    this.stripeClient = new Stripe(this.configService.secretKey);
  }

  // Constrói e valida eventos de webhook V1 (payload completo — snapshot events)
  constructEvent(payload: string | Buffer, signature: string) {
    return this.stripeClient.webhooks.constructEvent(
      payload,
      signature,
      this.configService.webhookSecret,
    );
  }

  // Constrói e valida Thin Events V2 usando o secret dedicado
  // Thin events usam o mesmo constructEvent, mas com um webhook secret separado
  constructThinEvent(payload: string | Buffer, signature: string) {
    if (!this.configService.thinWebhookSecret) {
      throw new Error(
        '❌ STRIPE_THIN_WEBHOOK_SECRET não está definida. Configure no Dashboard Stripe → Webhooks.',
      );
    }
    return this.stripeClient.webhooks.constructEvent(
      payload,
      signature,
      this.configService.thinWebhookSecret,
    );
  }
}
