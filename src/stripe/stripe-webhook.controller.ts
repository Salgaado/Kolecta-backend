import {
  Controller,
  Post,
  Req,
  Res,
  Headers,
  Inject,
  Logger,
} from '@nestjs/common';
import { StripeService } from './stripe.service';
import { WalletService } from '../wallet/wallet.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';

type Database = any;
type RawRequest = { rawBody?: Buffer; [key: string]: any };

@Controller('api/webhooks/stripe')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly walletService: WalletService,
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
        case 'checkout.session.completed': {
          const session = event.data.object;
          if (session.metadata?.type === 'wallet_deposit') {
            await this.handleWalletDeposit(session);
          } else {
            this.eventEmitter.emit('stripe.checkout.completed', session);
          }
          break;
        }
        case 'payment_intent.succeeded':
          this.eventEmitter.emit(
            'stripe.payment_intent.succeeded',
            event.data.object,
          );
          break;
        case 'payment_intent.payment_failed':
          await this.handlePaymentFailure(event.data.object);
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
      await this.db
        .update(schema.webhookEvents)
        .set({ status: 'processed' })
        .where(eq(schema.webhookEvents.stripeEventId, event.id));

      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error(`Error processing webhook event ${event.id}:`, error);

      await this.db
        .update(schema.webhookEvents)
        .set({ status: 'failed', errorMessage: error.message })
        .where(eq(schema.webhookEvents.stripeEventId, event.id));

      res
        .status(500)
        .send('Internal Server Error while executing webhook logic');
    }
  }

  // ── Wallet Deposit Handler ──────────────────────────────────────────────
  private async handleWalletDeposit(session: any) {
    const userId = session.metadata?.userId;
    const amountInCents = parseInt(session.metadata?.amountInCents, 10);

    if (!userId || isNaN(amountInCents)) {
      this.logger.error(
        `Sessão de depósito ${session.id} sem userId ou amountInCents válido no metadata.`,
      );
      return;
    }

    const wallet = await this.walletService.getOrCreateWallet(userId);

    await this.walletService.credit(
      wallet.id,
      amountInCents,
      `Depósito via Stripe (Sessão ${session.id.slice(0, 12)})`,
    );

    this.logger.log(
      `✅ Depósito de R$ ${(amountInCents / 100).toFixed(2)} creditado na wallet do usuário ${userId}`,
    );
  }

  // ── Payment Failure Rollback Handler ──────────────────────────────────────
  private async handlePaymentFailure(paymentIntent: any) {
    const orderId = paymentIntent.metadata?.orderId;
    const buyerId = paymentIntent.metadata?.buyerId;
    const walletDeducted = parseInt(paymentIntent.metadata?.walletDeducted, 10);

    if (!buyerId || isNaN(walletDeducted) || walletDeducted <= 0) {
      return;
    }

    this.logger.warn(
      `⚠️ Falha no pagamento PI ${paymentIntent.id}. Estornando R$ ${(walletDeducted / 100).toFixed(2)} para buyerId: ${buyerId}`,
    );

    const wallet = await this.walletService.getOrCreateWallet(buyerId);

    await this.walletService.credit(
      wallet.id,
      walletDeducted,
      `Estorno de saldo - Falha no pagamento (Pedido #${orderId?.slice(0, 8)})`,
      orderId,
    );
  }
}
