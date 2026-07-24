import { Module } from '@nestjs/common';
import { MailService } from './mail/mail.service';
import { OrderListener } from './listeners/order.listener';
import { KycListener } from './listeners/kyc.listener';
import { UserListener } from './listeners/user.listener';
import { ListingListener } from './listeners/listing.listener';

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
 * Cobertura atual:
 *  - pedido pago  → order-confirmed (comprador) + sale-made (vendedor)
 *  - KYC          → kyc-approved / kyc-action-needed
 *  - cadastro     → welcome (`user.registered`, do webhook do Clerk)
 *  - moderação    → listing-approved / listing-rejected (`listing.moderated`)
 *
 * Ainda sem gatilho (templates existem no kit do front): envio de pedido,
 * lances, arremate, mensagem, repasse e disputa.
 */
@Module({
  providers: [
    MailService,
    OrderListener,
    KycListener,
    UserListener,
    ListingListener,
  ],
  exports: [MailService],
})
export class NotificationsModule {}
