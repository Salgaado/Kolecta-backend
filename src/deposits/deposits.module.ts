import { Module } from '@nestjs/common';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';
import { StripeCoreModule } from '../stripe/stripe-core.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [StripeCoreModule, UsersModule],
  controllers: [DepositsController],
  providers: [DepositsService],
})
export class DepositsModule {}
