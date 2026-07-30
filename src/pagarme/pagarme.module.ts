import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PagarmeConfigService } from './pagarme-config.service';
import { PagarmeService } from './pagarme.service';
import { PagarmeWebhookController } from './pagarme-webhook.controller';
import { registerPagarmeDiag } from './pagarme-diagnostics';
import { WalletModule } from '../wallet/wallet.module';

/**
 * Núcleo da integração Pagar.me.
 *
 * Exporta o client HTTP reutilizável e o config service para os módulos de
 * deposits, recebedores, saques e compras. Hospeda também o webhook unificado
 * (Fase 2), que credita a wallet em `order.paid` e emite eventos internos para
 * as demais fases consumirem via @OnEvent.
 */
@Module({
  imports: [HttpModule, WalletModule],
  providers: [PagarmeConfigService, PagarmeService],
  controllers: [PagarmeWebhookController],
  exports: [PagarmeService, PagarmeConfigService],
})
export class PagarmeModule {
  constructor() {
    // Deixa `__pagarmeDiag()` acessível no console do processo.
    registerPagarmeDiag();
  }
}
