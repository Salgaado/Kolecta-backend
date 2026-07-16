import { Module } from '@nestjs/common';
import { SellersService } from './sellers.service';
import { SellersController } from './sellers.controller';
import { SellerSelfController } from './seller-self.controller';
import { DatabaseModule } from '../database/database.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [DatabaseModule, UsersModule],
  controllers: [SellersController, SellerSelfController],
  providers: [SellersService],
  exports: [SellersService],
})
export class SellersModule {}
