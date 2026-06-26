import { Module } from '@nestjs/common';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [PagarmeModule, UsersModule],
  controllers: [DepositsController],
  providers: [DepositsService],
})
export class DepositsModule {}
