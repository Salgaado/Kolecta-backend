import { Module } from '@nestjs/common';
import { CardsService } from './cards.service';
import { CardsController } from './cards.controller';
import { DatabaseModule } from '../database/database.module';
import { PagarmeModule } from '../pagarme/pagarme.module';

@Module({
  imports: [DatabaseModule, PagarmeModule],
  controllers: [CardsController],
  providers: [CardsService],
  exports: [CardsService],
})
export class CardsModule {}
