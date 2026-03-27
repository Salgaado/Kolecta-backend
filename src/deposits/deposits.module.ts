import { Module } from '@nestjs/common';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';
import { StripeCoreModule } from '../stripe/stripe-core.module';

@Module({
  imports: [StripeCoreModule],
  controllers: [DepositsController],
  providers: [DepositsService],
})
export class DepositsModule {}
