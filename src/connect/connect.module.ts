import { Module, forwardRef } from '@nestjs/common';
import { ConnectController } from './connect.controller';
import { ConnectService } from './connect.service';
import { StripeCoreModule } from '../stripe/stripe-core.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [forwardRef(() => StripeCoreModule), DatabaseModule],
  controllers: [ConnectController],
  providers: [ConnectService],
  exports: [ConnectService],
})
export class ConnectAccountsModule {}
