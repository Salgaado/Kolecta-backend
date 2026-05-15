import { Controller, Post, Get, Req } from '@nestjs/common';
import { ConnectService } from './connect.service';

@Controller('api/connect')
export class ConnectController {
  constructor(private readonly connectService: ConnectService) {}

  // Criar link de onboarding Stripe Connect V2
  @Post('onboard')
  async createOnboardingLink(@Req() req: any) {
    const userId = req.auth?.userId || req.user?.id;
    if (!userId) {
      throw new Error('Acesso negado: ID de Usuário Inexistente na Sessão');
    }
    const result = await this.connectService.getOnboardingLink(userId);
    return { data: result };
  }

  // Consultar status do onboarding diretamente na API Stripe V2
  @Get('status')
  async getAccountStatus(@Req() req: any) {
    const userId = req.auth?.userId || req.user?.id;
    if (!userId) {
      throw new Error('Acesso negado: ID de Usuário Inexistente na Sessão');
    }
    const status = await this.connectService.getAccountStatus(userId);
    return { data: status };
  }

  // Gerar login link para o Dashboard financeiro Stripe Express
  @Post('login')
  async createDashboardLoginLink(@Req() req: any) {
    const userId = req.auth?.userId || req.user?.id;
    if (!userId) {
      throw new Error('Acesso negado: ID de Usuário Inexistente na Sessão');
    }
    const result = await this.connectService.getLoginLink(userId);
    return { data: result };
  }

  // Buscar informações resumidas da conta bancária conectada
  @Get('bank-account')
  async getBankAccountInfo(@Req() req: any) {
    const userId = req.auth?.userId || req.user?.id;
    if (!userId) {
      throw new Error('Acesso negado: ID de Usuário Inexistente na Sessão');
    }
    const info = await this.connectService.getExternalAccountInfo(userId);
    return { data: info };
  }
}
