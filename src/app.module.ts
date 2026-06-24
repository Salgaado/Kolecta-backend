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
import { ShippingModule } from './shipping/shipping.module';
import { MessagesModule } from './messages/messages.module';
import { SellersModule } from './sellers/sellers.module';
import { ReviewsModule } from './reviews/reviews.module';
import { CategoriesModule } from './categories/categories.module';
import { CommunityModule } from './community/community.module';
import { MediaModule } from './media/media.module';
import { AdminModule } from './admin/admin.module';
import { BlingModule } from './bling/bling.module';
import { PagarmeModule } from './pagarme/pagarme.module';
import { ScheduleModule } from '@nestjs/schedule';
@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    // ── Pagamentos ──────────────────────────────────────
    // Pagar.me (migração em andamento — ver docs/PLAN-pagarme-migration.md)
    PagarmeModule,
    // Stripe (legado — em substituição)
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
    ShippingModule,
    MessagesModule,
    SellersModule,
    ReviewsModule,
    CategoriesModule,
    CommunityModule,
    MediaModule,
    AdminModule,
    BlingModule,
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
