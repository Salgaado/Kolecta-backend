import { Module } from '@nestjs/common';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { RecipientsService } from './recipients.service';
import { RecipientsController } from './recipients.controller';

/**
 * Recebedores Pagar.me + KYC (Fase 1 da migração de pagamentos /
 * Fase 1 do estudo KYC — ver docs/ESTUDO-kyc-e-emails.md).
 *
 * Aditivo: convive com o módulo Stripe Connect (connect/) até o cleanup.
 * DatabaseModule e EventEmitter são globais → não precisam ser importados.
 *
 * O webhook `POST /api/webhooks/pagarme` é único e vive no `PagarmeModule`
 * (controller unificado com idempotência). O sync de recebedor acontece via
 * listener `@OnEvent('pagarme.recipient.updated')` no RecipientsService.
 */
@Module({
  imports: [PagarmeModule],
  controllers: [RecipientsController],
  providers: [RecipientsService],
  exports: [RecipientsService],
})
export class RecipientsModule {}
