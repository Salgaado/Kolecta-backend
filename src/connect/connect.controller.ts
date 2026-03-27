import { Controller, Post, Req } from '@nestjs/common';
import { ConnectService } from './connect.service';

@Controller('connect')
export class ConnectController {
  constructor(private readonly connectService: ConnectService) {}

  @Post('onboard')
  async createOnboardingLink(@Req() req: any) {
    // Extraímos o userId usando a mesma política simplificada do MVP
    const userId = req.auth?.userId || req.user?.id;
    if (!userId) {
      throw new Error('Acesso negado: ID de Usuário Inexistente na Sessão');
    }
    return this.connectService.getOnboardingLink(userId);
  }

  @Post('login')
  async createDashboardLoginLink(@Req() req: any) {
    const userId = req.auth?.userId || req.user?.id;
    if (!userId) {
      throw new Error('Acesso negado: ID de Usuário Inexistente na Sessão');
    }
    return this.connectService.getLoginLink(userId);
  }
}
