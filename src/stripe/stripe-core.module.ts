import { Module, forwardRef } from '@nestjs/common';
import { StripeConfigService } from './stripe-config.service';
import { StripeService } from './stripe.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeThinWebhookController } from './stripe-thin-webhook.controller';
import { DatabaseModule } from '../database/database.module';
import { WalletModule } from '../wallet/wallet.module';
import { ConnectAccountsModule } from '../connect/connect.module';

@Module({
  imports: [DatabaseModule, WalletModule, forwardRef(() => ConnectAccountsModule)],
  providers: [StripeConfigService, StripeService],
  controllers: [StripeWebhookController, StripeThinWebhookController],
  exports: [StripeService, StripeConfigService],
})
export class StripeCoreModule {}
