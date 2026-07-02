import { Module } from '@nestjs/common';
import { MailService } from './mail/mail.service';
import { OrderListener } from './listeners/order.listener';
import { KycListener } from './listeners/kyc.listener';

/**
 * Módulo de notificações transacionais (e-mail).
 *
 * Arquitetura orientada a eventos: listeners `@OnEvent` reagem a eventos de
 * domínio (ex: `order.paid`) e disparam e-mails via MailService. Nunca é
 * acoplado ao fluxo principal — falha de e-mail não derruba o negócio.
 *
 * DatabaseModule é @Global, então a conexão (DATABASE_CONNECTION) já está
 * disponível sem import explícito.
 *
 * Fase 0: e-mails de pedido (order-confirmed, sale-made) via `order.paid`.
 * Próximas fases adicionam mais listeners (auction, payout, kyc) + templates.
 */
@Module({
  providers: [MailService, OrderListener, KycListener],
  exports: [MailService],
})
export class NotificationsModule {}
