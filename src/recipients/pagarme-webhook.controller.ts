import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Body,
  UnauthorizedException,
} from '@nestjs/common';
import { PagarmeConfigService } from '../pagarme/pagarme-config.service';
import { RecipientsService } from './recipients.service';

interface PagarmeWebhookEvent {
  id?: string;
  type?: string;
  data?: {
    id?: string;
    status?: string;
    [k: string]: any;
  };
}

/**
 * Webhook da Pagar.me — validação de origem via HTTP Basic Auth
 * (Pagar.me v5 não usa assinatura HMAC; ver docs/PLAN-pagarme-migration.md §⛔).
 *
 * Fase 1 (KYC): trata apenas `recipient.updated`. A Fase 2 da migração de
 * pagamentos estende o switch (order.paid, charge.refunded, transfer.*, etc.).
 */
@Controller('api/webhooks/pagarme')
export class PagarmeWebhookController {
  private readonly logger = new Logger(PagarmeWebhookController.name);

  constructor(
    private readonly config: PagarmeConfigService,
    private readonly recipients: RecipientsService,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Headers('authorization') authHeader: string | undefined,
    @Body() event: PagarmeWebhookEvent,
  ): Promise<{ received: boolean }> {
    this.assertBasicAuth(authHeader);

    const type = event?.type ?? 'unknown';
    this.logger.log(
      `Webhook Pagar.me recebido: ${type} (event ${event?.id ?? '—'})`,
    );

    switch (type) {
      case 'recipient.updated': {
        const recipientId = event.data?.id;
        const status = event.data?.status;
        if (recipientId && status) {
          await this.recipients.syncRecipientStatus(recipientId, status);
        } else {
          this.logger.warn('recipient.updated sem id/status no payload.');
        }
        break;
      }

      // Fase 2 da migração estende aqui (order.paid, charge.refunded, transfer.*)
      default:
        this.logger.debug(
          `Evento "${type}" não tratado nesta fase — ignorado.`,
        );
    }

    return { received: true };
  }

  /**
   * Valida o Basic Auth configurado no dashboard da Pagar.me.
   * Se as credenciais não estiverem configuradas no ambiente, recusa por
   * segurança (fail-closed) — exceto que loga aviso claro.
   */
  private assertBasicAuth(authHeader: string | undefined): void {
    const user = this.config.webhookUser;
    const pass = this.config.webhookPassword;

    if (!user || !pass) {
      this.logger.error(
        'PAGARME_WEBHOOK_USER/PASSWORD não configurados — webhook recusado (fail-closed).',
      );
      throw new UnauthorizedException('Webhook não configurado.');
    }

    const expected =
      'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    if (!authHeader || authHeader !== expected) {
      this.logger.warn('Webhook Pagar.me com Basic Auth inválido — recusado.');
      throw new UnauthorizedException('Credenciais de webhook inválidas.');
    }
  }
}
