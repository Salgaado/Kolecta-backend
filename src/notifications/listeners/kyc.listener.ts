import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MailService } from '../mail/mail.service';

interface KycApprovedEvent {
  userId: string;
  email: string;
  name: string | null;
}

interface KycActionNeededEvent {
  userId: string;
  email: string;
  name: string | null;
  status: string;
}

/**
 * E-mails de KYC do recebedor (Pagar.me). Disparados pelos eventos emitidos em
 * RecipientsService.syncRecipientStatus quando o status muda.
 */
@Injectable()
export class KycListener {
  constructor(private readonly mail: MailService) {}

  @OnEvent('recipient.kyc.approved')
  async onApproved(event: KycApprovedEvent): Promise<void> {
    await this.mail.send({
      to: event.email,
      template: 'kyc-approved',
      // refId pelo usuário: idempotência (não reenvia "aprovado" duplicado)
      refId: `kyc-approved-${event.userId}`,
      data: { name: event.name },
    });
  }

  @OnEvent('recipient.kyc.action_needed')
  async onActionNeeded(event: KycActionNeededEvent): Promise<void> {
    await this.mail.send({
      to: event.email,
      template: 'kyc-action-needed',
      // refId inclui status: reenvia se cair em estado problemático diferente
      refId: `kyc-action-${event.userId}-${event.status}`,
      data: { name: event.name, status: event.status },
    });
  }
}
