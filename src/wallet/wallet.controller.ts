import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/wallet')
@UseGuards(AuthGuard, RolesGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get('me')
  @Roles('user', 'admin')
  async getMyWallet(@Request() req: any) {
    const userId = req.auth.userId;
    const wallet = await this.walletService.getOrCreateWallet(userId);
    return { data: wallet };
  }

  @Get('transactions')
  @Roles('user', 'admin')
  async getMyTransactions(@Request() req: any) {
    const userId = req.auth.userId;
    const transactions = await this.walletService.getTransactions(userId);
    return { data: transactions };
  }
}
