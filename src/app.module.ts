import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
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
import { AddressesModule } from './addresses/addresses.module';
import { FavoritesModule } from './favorites/favorites.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { AuctionsModule } from './auctions/auctions.module';
import { DevAuthMiddleware } from './auth/dev-auth.middleware';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    // ── Stripe ──────────────────────────────────────────
    StripeCoreModule,
    DepositsModule,
    ConnectAccountsModule,
    WithdrawalsModule,
    // ── Core ────────────────────────────────────────────
    DatabaseModule,
    WebhookModule,
    AuthModule,
    UsersModule,
    // ── Domain ──────────────────────────────────────────
    ListingsModule,
    OrdersModule,
    AuctionsModule,
    WalletModule,
    AddressesModule,
    FavoritesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Apenas em ambiente de desenvolvimento — injeta req.auth mock
    if (process.env.NODE_ENV !== 'production') {
      consumer.apply(DevAuthMiddleware).forRoutes('*');
    }
  }
}
