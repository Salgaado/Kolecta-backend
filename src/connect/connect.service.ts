import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { StripeService } from '../stripe/stripe.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';

// Avoid deep dependency typing to keep code short
type Database = any;

@Injectable()
export class ConnectService {
  private readonly logger = new Logger(ConnectService.name);
  constructor(
    private readonly stripeService: StripeService,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  async getOnboardingLink(userId: string) {
    // 1. Encontrar o seller_profile
    const [seller] = await this.db.select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!seller) {
      throw new NotFoundException('Perfil de Vendedor não encontrado.');
    }

    let accountId = seller.stripeAccountId;

    // 2. Se não tiver ID da conta Stripe Express, criar uma no Stripe
    if (!accountId) {
      const account = await this.stripeService.stripe.accounts.create({
        type: 'express',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });

      accountId = account.id;

      // Persistir na base
      await this.db.update(schema.sellerProfiles)
        .set({ stripeAccountId: accountId })
        .where(eq(schema.sellerProfiles.id, seller.id));
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    // 3. Gerar link de account link (onboarding ou retomar onboarding)
    const accountLink = await this.stripeService.stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${frontendUrl}/connect/refresh`,
      return_url: `${frontendUrl}/connect/success`,
      type: 'account_onboarding',
    });

    return { url: accountLink.url };
  }

  async getLoginLink(userId: string) {
    const [seller] = await this.db.select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!seller || !seller.stripeAccountId) {
      throw new BadRequestException('A conta Connect do vendedor não foi inicializada.');
    }

    // Gerar link de login para o Dashboard financeiro do Stripe Express
    const loginLink = await this.stripeService.stripe.accounts.createLoginLink(
      seller.stripeAccountId
    );

    return { url: loginLink.url };
  }

  @OnEvent('stripe.account.updated')
  async handleAccountUpdated(account: any) {
    this.logger.log(`Sincronizando status da conta Connect: ${account.id}`);

    // Encontrar o seller pelo stripeAccountId
    const [seller] = await this.db.select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.stripeAccountId, account.id));

    if (!seller) {
      this.logger.warn(`Nenhum seller encontrado com stripeAccountId=${account.id}. Ignorando.`);
      return;
    }

    // Uma conta está "pronta para receber" quando charges_enabled e payouts_enabled são true
    const isReadyToReceive = account.charges_enabled && account.payouts_enabled;

    await this.db.update(schema.sellerProfiles)
      .set({ isVerified: isReadyToReceive })
      .where(eq(schema.sellerProfiles.id, seller.id));

    this.logger.log(
      `✅ Seller ${seller.id} sincronizado: isVerified=${isReadyToReceive} ` +
      `(charges_enabled=${account.charges_enabled}, payouts_enabled=${account.payouts_enabled})`
    );
  }
}
