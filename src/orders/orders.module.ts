import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { ReleaseBalanceCron } from './release-balance.cron';
import { WalletModule } from '../wallet/wallet.module';
import { UsersModule } from '../users/users.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { DatabaseModule } from '../database/database.module';
import { FounderModule } from '../founder/founder.module';

@Module({
  imports: [WalletModule, UsersModule, PagarmeModule, DatabaseModule, FounderModule],
  controllers: [OrdersController],
  providers: [OrdersService, ReleaseBalanceCron],
})
export class OrdersModule {}
