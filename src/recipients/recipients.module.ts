import { Module } from '@nestjs/common';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { RecipientsService } from './recipients.service';
import { RecipientsController } from './recipients.controller';
import { PagarmeWebhookController } from './pagarme-webhook.controller';

/**
 * Recebedores Pagar.me + KYC (Fase 1 da migração de pagamentos /
 * Fase 1 do estudo KYC — ver docs/ESTUDO-kyc-e-emails.md).
 *
 * Aditivo: convive com o módulo Stripe Connect (connect/) até o cleanup.
 * DatabaseModule e EventEmitter são globais → não precisam ser importados.
 */
@Module({
  imports: [PagarmeModule],
  controllers: [RecipientsController, PagarmeWebhookController],
  providers: [RecipientsService],
  exports: [RecipientsService],
})
export class RecipientsModule {}
