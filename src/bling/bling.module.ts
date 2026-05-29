import { Module } from '@nestjs/common';
import { BlingService } from './bling.service';
import { BlingController } from './bling.controller';
import { BlingSyncService } from './bling-sync.service';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [BlingController],
  providers: [BlingService, BlingSyncService],
  exports: [BlingService],
})
export class BlingModule {}
