import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { WalletModule } from '../wallet/wallet.module';
import { UsersModule } from '../users/users.module';
import { StripeCoreModule } from '../stripe/stripe-core.module';

@Module({
  imports: [WalletModule, UsersModule, StripeCoreModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
