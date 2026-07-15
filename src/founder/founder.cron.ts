import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FounderService } from './founder.service';

/**
 * Job diário de manutenção do Programa Membro Fundador (regra dos 15 dias).
 * Ver docs/PLAN-programa-fundadores.md (T6).
 */
@Injectable()
export class FounderMaintenanceCron {
  private readonly logger = new Logger(FounderMaintenanceCron.name);

  constructor(private readonly founderService: FounderService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleMaintenance() {
    this.logger.log('⏰ Manutenção de fundadores (regra dos 15 dias)...');
    try {
      await this.founderService.runMaintenance();
    } catch (err: any) {
      this.logger.error(`Falha na manutenção de fundadores: ${err.message}`);
    }
  }
}
