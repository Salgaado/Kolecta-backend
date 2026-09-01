import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { ReleaseBalanceCron } from './release-balance.cron';
import { WalletModule } from '../wallet/wallet.module';
import { UsersModule } from '../users/users.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { DatabaseModule } from '../database/database.module';
import { FounderModule } from '../founder/founder.module';
import { ShippingModule } from '../shipping/shipping.module';

@Module({
  // ShippingModule entra pelo ShippingService (o checkout RECOTA o frete no
  // servidor, em vez de acreditar no valor que veio do navegador) e pelo
  // FreteSubsidioService (frete compartilhado).
  imports: [
    WalletModule,
    UsersModule,
    PagarmeModule,
    DatabaseModule,
    FounderModule,
    ShippingModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, ReleaseBalanceCron],
})
export class OrdersModule {}
