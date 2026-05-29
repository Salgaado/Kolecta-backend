import { Module } from '@nestjs/common';
import { AuctionsService } from './auctions.service';
import { AuctionsController } from './auctions.controller';
import { CloseAuctionsCron } from './close-auctions.cron';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [DatabaseModule, AuthModule, WalletModule],
  controllers: [AuctionsController],
  providers: [AuctionsService, CloseAuctionsCron],
  exports: [AuctionsService],
})
export class AuctionsModule {}
