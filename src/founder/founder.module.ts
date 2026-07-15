import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FounderService } from './founder.service';
import { FounderController } from './founder.controller';
import { FounderMaintenanceCron } from './founder.cron';

@Module({
  imports: [DatabaseModule],
  controllers: [FounderController],
  providers: [FounderService, FounderMaintenanceCron],
  exports: [FounderService],
})
export class FounderModule {}
