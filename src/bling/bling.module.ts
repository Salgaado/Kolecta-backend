import { Module } from '@nestjs/common';
import { BlingService } from './bling.service';
import { BlingImportService } from './bling-import.service';
import { BlingController } from './bling.controller';
import { BlingSyncService } from './bling-sync.service';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [BlingController],
  providers: [BlingService, BlingImportService, BlingSyncService],
  exports: [BlingService],
})
export class BlingModule {}
