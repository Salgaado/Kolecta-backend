import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  UnauthorizedException,
  InternalServerErrorException,
  Inject,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { WalletService } from '../wallet/wallet.service';
import { PagarmeConfigService } from './pagarme-config.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

type Database = any;

/**
 * Webhook unificado da Pagar.me.
 *
 * Substitui os dois controllers da Stripe (checkout + thin events). A Pagar.me v5
 * NÃO usa assinatura HMAC — a validação de origem é via HTTP Basic Auth, com
 * usuário/senha definidos por endpoint no dashboard (PAGARME_WEBHOOK_USER/PASSWORD).
 *
 * Idempotência reaproveita a tabela `webhook_events` (coluna `stripe_event_id`
 * guarda o id do evento Pagar.me — a coluna será renomeada para `provider_event_id`
 * no cleanup/migração da Fase 7; ver docs/PLAN-pagarme-migration.md).
 */
@Controller('api/webhooks/pagarme')
export class PagarmeWebhookController {
  private readonly logger = new Logger(PagarmeWebhookController.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: PagarmeConfigService,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  @Post()
  @HttpCode(200)
  async handleWebhook(
    @Body() event: PagarmeWebhookEvent,
    @Headers('authorization') authHeader?: string,
  ) {
    // ── Validação de origem (Basic Auth — não há HMAC na Pagar.me v5) ──
    if (!this.isAuthorized(authHeader)) {
      this.logger.warn('Webhook Pagar.me rejeitado: Basic Auth inválido.');
      throw new UnauthorizedException('Invalid webhook credentials');
    }

    if (!event?.id || !event?.type) {
      this.logger.warn('Webhook Pagar.me sem id/type — ignorado.');
      return { received: true };
    }

    // ── Idempotência ──
    const existing = await this.db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.stripeEventId, event.id),
    });

    if (existing) {
      this.logger.log(`Webhook já processado: ${event.id} (${event.type})`);
      return { received: true, alreadyProcessed: true };
    }

    await this.db.insert(schema.webhookEvents).values({
      stripeEventId: event.id,
      type: event.type,
      status: 'pending',
    });

    try {
      this.logger.log(`🔔 Webhook Pagar.me: ${event.type} (${event.id})`);
      await this.route(event);

      await this.db
        .update(schema.webhookEvents)
        .set({ status: 'processed' })
        .where(eq(schema.webhookEvents.stripeEventId, event.id));

      return { received: true };
    } catch (error: any) {
      this.logger.error(
        `Erro processando webhook ${event.id} (${event.type}): ${error.message}`,
      );

      await this.db
        .update(schema.webhookEvents)
        .set({ status: 'failed', errorMessage: error.message })
        .where(eq(schema.webhookEvents.stripeEventId, event.id));

      // 500 → a Pagar.me reenvia o evento (política de retry deles).
      throw new InternalServerErrorException('Webhook processing failed');
    }
  }

  // ── Roteamento de eventos ───────────────────────────────────────────────────
  private async route(event: PagarmeWebhookEvent): Promise<void> {
    const data = event.data ?? {};

    switch (event.type) {
      // ─── Pedidos ───────────────────────────────────────────────────────────
      case 'order.paid':
        if (data.metadata?.type === 'wallet_deposit') {
          await this.handleWalletDeposit(data);
        } else {
          // Confirmação de compra (checkout) → Fase 5 trata via @OnEvent.
          this.eventEmitter.emit('pagarme.order.paid', data);
        }
        break;

      case 'order.payment_failed':
      case 'order.canceled':
        // Rollback de débito parcial da wallet em compra híbrida → Fase 5.
        this.eventEmitter.emit('pagarme.order.failed', data);
        break;

      // ─── Cobranças ──────────────────────────────────────────────────────────
      case 'charge.refunded':
        // Estorno → crédito na wallet + ledger refund (Fase 5).
        this.eventEmitter.emit('pagarme.charge.refunded', data);
        break;

      case 'chargeback.received':
        // Chargeback → abre disputa + bloqueia release (Fase 5).
        // Nome real do evento Pagar.me é `chargeback.received` (não `charge.chargedback`).
        this.eventEmitter.emit('pagarme.charge.chargedback', data);
        break;

      // ─── Recebedores (Fase 3) ───────────────────────────────────────────────
      case 'recipient.created':
      case 'recipient.updated':
        this.eventEmitter.emit('pagarme.recipient.updated', data);
        break;

      // ─── Saques / transferências (Fase 4) ───────────────────────────────────
      case 'transfer.paid':
      case 'transfer.failed':
      case 'transfer.canceled':
      case 'transfer.pending':
      case 'transfer.processing':
      case 'transfer.created':
        this.eventEmitter.emit('pagarme.transfer.updated', data);
        break;

      default:
        this.logger.debug(`Evento Pagar.me ignorado: ${event.type}`);
        break;
    }
  }

  // ── Crédito de depósito na wallet ───────────────────────────────────────────
  private async handleWalletDeposit(order: any): Promise<void> {
    const userId = order.metadata?.userId;
    // Usa o valor efetivamente pago (order.amount) como fonte da verdade;
    // o metadata é só fallback / conferência.
    const amountInCents =
      typeof order.amount === 'number'
        ? order.amount
        : parseInt(order.metadata?.amountInCents, 10);

    if (!userId || !Number.isFinite(amountInCents) || amountInCents <= 0) {
      this.logger.error(
        `Pedido de depósito ${order.id} sem userId/amount válido no metadata.`,
      );
      return;
    }

    const wallet = await this.walletService.getOrCreateWallet(userId);

    await this.walletService.credit(
      wallet.id,
      amountInCents,
      `Depósito via Pagar.me (Pedido ${String(order.id).slice(0, 12)})`,
    );

    this.logger.log(
      `✅ Depósito de R$ ${(amountInCents / 100).toFixed(2)} creditado na wallet do usuário ${userId}`,
    );
  }

  // ── Basic Auth ──────────────────────────────────────────────────────────────
  private isAuthorized(authHeader?: string): boolean {
    const user = this.config.webhookUser;
    const password = this.config.webhookPassword;

    // Sem credenciais configuradas → modo dev: loga aviso e libera.
    // Em produção, configure PAGARME_WEBHOOK_USER/PASSWORD no .env e no dashboard.
    if (!user || !password) {
      this.logger.warn(
        'PAGARME_WEBHOOK_USER/PASSWORD não configurados — validação de Basic Auth desativada (DEV).',
      );
      return true;
    }

    if (!authHeader?.startsWith('Basic ')) return false;

    const expected =
      'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    return authHeader === expected;
  }
}

// ── Tipagem mínima do payload de webhook da Pagar.me ──────────────────────────
interface PagarmeWebhookEvent {
  id: string;
  type: string;
  created_at?: string;
  data: any;
}
