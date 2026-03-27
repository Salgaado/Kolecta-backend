import { Module } from '@nestjs/common';
import { ConnectController } from './connect.controller';
import { ConnectService } from './connect.service';
import { StripeCoreModule } from '../stripe/stripe-core.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [StripeCoreModule, DatabaseModule],
  controllers: [ConnectController],
  providers: [ConnectService],
})
export class ConnectAccountsModule {}
