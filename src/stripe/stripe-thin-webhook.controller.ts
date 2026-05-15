import {
  Controller,
  Post,
  Req,
  Res,
  Headers,
  Logger,
} from '@nestjs/common';
import { StripeService } from './stripe.service';
import { ConnectService } from '../connect/connect.service';

type RawRequest = { rawBody?: Buffer; [key: string]: any };

/**
 * Handler dedicado para Thin Events V2 do Stripe Connect.
 *
 * Thin Events são notificações leves que incluem apenas o ID do recurso afetado.
 * O fluxo: receber evento → extrair related_object.id → buscar dados atualizados → processar.
 *
 * Endpoint: POST /api/webhooks/stripe-v2
 *
 * Para configurar no Dashboard Stripe:
 * 1. Vá em Developers > Webhooks > Add destination
 * 2. Em Advanced settings, ative "Use thin events"
 * 3. Inscreva-se nos eventos:
 *    - v2.core.account.updated
 *    - v2.core.account.created
 * 4. Use a URL: https://seu-dominio.com/api/webhooks/stripe-v2
 * 5. Copie o signing secret para STRIPE_THIN_WEBHOOK_SECRET
 *
 * Para testar localmente:
 * stripe listen --forward-to http://localhost:3000/api/webhooks/stripe-v2
 */
@Controller('api/webhooks/stripe-v2')
export class StripeThinWebhookController {
  private readonly logger = new Logger(StripeThinWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly connectService: ConnectService,
  ) {}

  @Post()
  async handleThinWebhook(
    @Req() req: RawRequest,
    @Res() res: any,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!signature || !req.rawBody) {
      return res.status(400).send('Missing signature or body payload');
    }

    let event: any;
    try {
      // Valida a assinatura usando o secret dedicado para thin events
      event = this.stripeService.constructThinEvent(req.rawBody, signature);
    } catch (err: any) {
      this.logger.error(`⚠️ Thin Event signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    this.logger.log(`🔔 Thin Event recebido: ${event.type} (ID: ${event.id})`);

    try {
      // Extrair o ID da conta conectada do related_object ou do próprio data
      const accountId =
        event.data?.object?.id ||
        event.data?.related_object?.id ||
        event.account;

      if (!accountId) {
        this.logger.warn(`Evento ${event.type} sem account ID identificável. Ignorando.`);
        return res.status(200).json({ received: true });
      }

      // Rotear por tipo de evento
      switch (event.type) {
        // ── V2 Thin Events ──
        case 'v2.core.account.updated':
        case 'v2.core.account[requirements].updated': {
          await this.connectService.syncAccountRequirements(accountId);
          await this.connectService.syncCapabilityStatus(accountId);
          break;
        }

        case 'v2.core.account.created': {
          this.logger.log(`Nova conta V2 criada: ${accountId}`);
          break;
        }

        // ── Fallback: V1 snapshot events de Connect ──
        case 'account.updated': {
          const acctId = event.data?.object?.id;
          if (acctId) {
            await this.connectService.syncAccountRequirements(acctId);
            await this.connectService.syncCapabilityStatus(acctId);
          }
          break;
        }

        default:
          this.logger.warn(`Evento tipo não tratado: ${event.type}`);
          break;
      }

      return res.status(200).json({ received: true });
    } catch (error: any) {
      this.logger.error(`Erro ao processar evento ${event.id}: ${error.message}`);
      return res.status(500).send('Internal Server Error');
    }
  }
}
