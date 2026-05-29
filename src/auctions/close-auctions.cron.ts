import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuctionsService } from './auctions.service';

@Injectable()
export class CloseAuctionsCron {
  private readonly logger = new Logger(CloseAuctionsCron.name);

  constructor(private readonly auctionsService: AuctionsService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCloseExpiredAuctions() {
    this.logger.log('Verificando leilões expirados...');
    const closed = await this.auctionsService.endExpiredAuctions();
    if (closed.length > 0) {
      this.logger.log(`${closed.length} leilão(ões) encerrado(s): ${closed.join(', ')}`);
    }
  }
}
