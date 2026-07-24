import { Module } from '@nestjs/common';
import { MailService } from './mail/mail.service';
import { OrderListener } from './listeners/order.listener';
import { KycListener } from './listeners/kyc.listener';
import { UserListener } from './listeners/user.listener';
import { ListingListener } from './listeners/listing.listener';
import { AuctionListener } from './listeners/auction.listener';
import { MessageListener } from './listeners/message.listener';
import { FinanceListener } from './listeners/finance.listener';
import { DisputeListener } from './listeners/dispute.listener';

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
 * Cobertura (14 templates, todos com gatilho):
 *  - cadastro     → welcome                          (`user.registered`)
 *  - moderação    → listing-approved / -rejected     (`listing.moderated`)
 *  - pedido pago  → order-confirmed + sale-made      (`order.paid`)
 *  - postagem     → order-shipped                    (`order.shipped`)
 *  - leilão       → bid-received + bid-outbid        (`auction.bid.placed`)
 *  - arremate     → auction-won                      (`auction.won`)
 *  - conversa     → message-received                 (`message.received`)
 *  - financeiro   → payout-released                  (`payout.released`)
 *  - disputa      → dispute-opened                   (`dispute.opened`)
 *  - KYC          → kyc-approved / -action-needed    (`recipient.kyc.*`)
 */
@Module({
  providers: [
    MailService,
    OrderListener,
    KycListener,
    UserListener,
    ListingListener,
    AuctionListener,
    MessageListener,
    FinanceListener,
    DisputeListener,
  ],
  exports: [MailService],
})
export class NotificationsModule {}
