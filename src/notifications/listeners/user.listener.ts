import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MailService } from '../mail/mail.service';

interface UserRegisteredEvent {
  id: string;
  email: string | undefined;
  name: string | null;
}

/**
 * E-mail de boas-vindas. Disparado pelo evento `user.registered`, emitido no
 * WebhookService após o `user.created` do Clerk gravar o usuário no Turso.
 */
@Injectable()
export class UserListener {
  constructor(private readonly mail: MailService) {}

  @OnEvent('user.registered')
  async onRegistered(event: UserRegisteredEvent): Promise<void> {
    if (!event.email) return; // sem e-mail no Clerk não há o que enviar

    await this.mail.send({
      to: event.email,
      template: 'welcome',
      // refId pelo usuário: boas-vindas é uma vez só, mesmo se o webhook repetir
      // (o Clerk reentrega em falha, e o insert pode rodar de novo).
      refId: `welcome-${event.id}`,
      data: { name: event.name },
    });
  }
}
