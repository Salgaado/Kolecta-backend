import { Controller, Get, Request } from '@nestjs/common';
import { WalletService } from './wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get('me')
  async getMyWallet(@Request() req: any) {
    // Assume Clerk middleware or guard injects userId
    // Na Fase de refinamento, aplicaremos o ClerkAuthGuard adequadamente.
    const userId = req.auth?.userId || req.user?.id;
    if (!userId) {
      throw new Error('User not found in request context');
    }
    return this.walletService.getOrCreateWallet(userId);
  }
}
