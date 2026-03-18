import { Controller, Post, Headers, Req, Res, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Webhook } from 'svix';
import { WebhookService } from './webhook.service';

@Controller('api/webhooks/clerk')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  async handleWebhook(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('svix-id') svixId: string,
    @Headers('svix-timestamp') svixTimestamp: string,
    @Headers('svix-signature') svixSignature: string,
  ) {
    // 1. Validar presença dos headers Svix
    if (!svixId || !svixTimestamp || !svixSignature) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ message: 'Erro: headers Svix ausentes.' });
    }

    const whSecret = process.env.CLERK_WEBHOOK_SECRET;

    if (!whSecret) {
      this.logger.error('CLERK_WEBHOOK_SECRET não configurado.');
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ message: 'Configuração de webhook ausente.' });
    }

    // 2. Verificar assinatura Svix
    const wh = new Webhook(whSecret);
    let evt: { type: string; data: any };

    try {
      evt = wh.verify(JSON.stringify(req.body), {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': svixSignature,
      }) as { type: string; data: any };
    } catch (err) {
      this.logger.error('Falha na verificação da assinatura Svix:', err.message);
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ message: 'Assinatura de webhook inválida.' });
    }

    // 3. Delegar processamento ao WebhookService
    this.logger.log(`[Clerk Webhook] Evento recebido: ${evt.type}`);
    await this.webhookService.handleEvent(evt);

    return res.status(HttpStatus.OK).json({ success: true });
  }
}
