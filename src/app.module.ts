import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { WebhookModule } from './webhook/webhook.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ListingsModule } from './listings/listings.module';
import { OrdersModule } from './orders/orders.module';
import { WalletModule } from './wallet/wallet.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { StripeCoreModule } from './stripe/stripe-core.module';
import { DepositsModule } from './deposits/deposits.module';
import { ConnectAccountsModule } from './connect/connect.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    StripeCoreModule,
    DepositsModule,
    ConnectAccountsModule,
    DatabaseModule,
    WebhookModule,
    AuthModule,
    UsersModule,
    ListingsModule,
    OrdersModule,
    WalletModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
