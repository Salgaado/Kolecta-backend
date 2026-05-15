import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { ReleaseBalanceCron } from './release-balance.cron';
import { WalletModule } from '../wallet/wallet.module';
import { UsersModule } from '../users/users.module';
import { StripeCoreModule } from '../stripe/stripe-core.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [WalletModule, UsersModule, StripeCoreModule, DatabaseModule],
  controllers: [OrdersController],
  providers: [OrdersService, ReleaseBalanceCron],
})
export class OrdersModule {}
