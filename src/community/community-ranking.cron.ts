import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CommunityService } from './community.service';

@Injectable()
export class CommunityRankingCron {
  private readonly logger = new Logger(CommunityRankingCron.name);

  constructor(private readonly community: CommunityService) {}

  // Recomputa o score de relevância dos posts recentes a cada 15 minutos.
  @Cron('*/15 * * * *')
  async handleRecomputeScores() {
    const count = await this.community.recomputeScores();
    if (count > 0) {
      this.logger.log(`Ranking recomputado para ${count} post(s).`);
    }
  }
}
