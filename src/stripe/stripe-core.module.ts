import { Module } from '@nestjs/common';
import { StripeConfigService } from './stripe-config.service';
import { StripeService } from './stripe.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { DatabaseModule } from '../database/database.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [DatabaseModule, WalletModule],
  providers: [StripeConfigService, StripeService],
  controllers: [StripeWebhookController],
  exports: [StripeService, StripeConfigService],
})
export class StripeCoreModule {}
