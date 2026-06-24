import { Module } from '@nestjs/common';
import { CommunityController } from './community.controller';
import { CommunityAdminController } from './community-admin.controller';
import { CommunityService } from './community.service';
import { CommunityRankingCron } from './community-ranking.cron';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [CommunityController, CommunityAdminController],
  providers: [CommunityService, CommunityRankingCron],
  exports: [CommunityService],
})
export class CommunityModule {}
