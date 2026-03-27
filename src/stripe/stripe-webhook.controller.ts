import { Controller, Post, Req, Res, Headers, Inject } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';

// Tipagem em vez de dependência pesada pra simplificar
type Database = any;
type RawRequest = { rawBody?: Buffer; [key: string]: any };

@Controller('api/webhooks/stripe')
export class StripeWebhookController {
  constructor(
    private readonly stripeService: StripeService,
    private readonly eventEmitter: EventEmitter2,
    @Inject('DATABASE_CONNECTION') private readonly db: Database,
  ) {}

  @Post()
  async handleWebhook(
    @Req() req: RawRequest,
    @Res() res: any,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!signature || !req.rawBody) {
      return res.status(400).send('Missing signature or body payload');
    }

    let event;
    try {
      event = this.stripeService.constructEvent(req.rawBody, signature);
    } catch (err: any) {
      console.error(`⚠️  Webhook signature verification failed.`, err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ── Idempotency Check ──
    const existingEvent = await this.db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.stripeEventId, event.id),
    });

    if (existingEvent) {
      console.log(`Webhook already processed: ${event.id}`);
      return res.status(200).send('Already processed');
    }

    // Record the event as pending
    await this.db.insert(schema.webhookEvents).values({
      stripeEventId: event.id,
      type: event.type,
      status: 'pending',
    });

    try {
      // ── Handle Specific Events ──
      console.log(`🔔 Received Stripe Webhook: ${event.type}`);

      switch (event.type) {
        case 'checkout.session.completed':
          this.eventEmitter.emit('stripe.checkout.completed', event.data.object);
          break;
        case 'payment_intent.succeeded':
          this.eventEmitter.emit('stripe.payment_intent.succeeded', event.data.object);
          break;
        case 'account.updated':
          // Dispara sync do status do seller (capacidades, verificação, etc)
          this.eventEmitter.emit('stripe.account.updated', event.data.object);
          break;
        default:
          // Ignore other events
          break;
      }

      // Mark as processed
      await this.db.update(schema.webhookEvents)
        .set({ status: 'processed' })
        .where(eq(schema.webhookEvents.stripeEventId, event.id));
        
      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error(`Error processing webhook event ${event.id}:`, error);
      
      await this.db.update(schema.webhookEvents)
        .set({ status: 'failed', errorMessage: error.message })
        .where(eq(schema.webhookEvents.stripeEventId, event.id));
        
      res.status(500).send('Internal Server Error while executing webhook logic');
    }
  }
}
