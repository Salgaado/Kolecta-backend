import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { StripeService } from '../stripe/stripe.service';
import { DATABASE_CONNECTION } from '../database/database.module';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';

type Database = any;

@Injectable()
export class ConnectService {
  private readonly logger = new Logger(ConnectService.name);
  constructor(
    private readonly stripeService: StripeService,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  // ── Criar conta V2 + gerar link de onboarding ─────────────────────────────

  async getOnboardingLink(userId: string) {
    // 1. Buscar o seller_profile e os dados do usuário
    let [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!seller) {
      // Auto-create seller profile for users starting their onboarding process
      const [newSeller] = await this.db
        .insert(schema.sellerProfiles)
        .values({
          userId,
          stripeOnboardingStatus: 'not_started',
        })
        .returning();
      seller = newSeller;
    }

    // Buscar dados do usuário para display_name e email
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    let accountId = seller.stripeAccountId;

    // 2. Se não tiver conta Stripe, criar via API V2
    if (!accountId) {
      const account = await this.stripeService.stripeClient.v2.core.accounts.create({
        display_name: user?.name || 'Vendedor Kolecta',
        contact_email: user?.email || undefined,
        identity: {
          country: 'BR',
        },
        dashboard: 'express',
        defaults: {
          responsibilities: {
            fees_collector: 'application',
            losses_collector: 'application',
          },
        },
        configuration: {
          merchant: {
            capabilities: {
              card_payments: {
                requested: true,
              },
            },
          },
          recipient: {
            capabilities: {
              stripe_balance: {
                stripe_transfers: {
                  requested: true,
                },
              },
            },
          },
        },
      });

      this.logger.log(`✅ Conta Stripe V2 criada com sucesso: ${account.id}`);

      accountId = account.id;

      // Persistir o ID da conta V2 no banco
      await this.db
        .update(schema.sellerProfiles)
        .set({
          stripeAccountId: accountId,
          stripeOnboardingStatus: 'pending',
        })
        .where(eq(schema.sellerProfiles.id, seller.id));

      this.logger.log(`✅ Conta Stripe V2 criada: ${accountId} para seller ${seller.id}`);
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    // 3. Gerar Account Link V2 para onboarding
    try {
      const accountLink = await this.stripeService.stripeClient.v2.core.accountLinks.create({
        account: accountId,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: {
            configurations: ['merchant', 'recipient'], // Ambos fluxos de onboarding
            refresh_url: `${frontendUrl}/connect/refresh`,
            return_url: `${frontendUrl}/connect/success?accountId=${accountId}`,
          },
        },
      });

      return { url: accountLink.url };
    } catch (error) {
      this.logger.error(`❌ Erro ao criar Account Link V2: ${error.message}`);
      throw error;
    }
  }

  // ── Consultar status do onboarding direto na API V2 ────────────────────────

  async getAccountStatus(userId: string) {
    const [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!seller) {
      return {
        stripeAccountId: null,
        status: 'disconnected',
        chargesEnabled: false,
        payoutsEnabled: false,
      };
    }

    // Se não tem conta Stripe ainda, retornar status inicial
    if (!seller.stripeAccountId) {
      return {
        stripeAccountId: null,
        status: 'disconnected',
        chargesEnabled: false,
        payoutsEnabled: false,
      };
    }

    // Buscar status atualizado diretamente da API V2
    const account = await this.stripeService.stripeClient.v2.core.accounts.retrieve(
      seller.stripeAccountId,
      { include: ['configuration.recipient', 'configuration.merchant', 'requirements'] },
    );

    const merchantCap = (account as any)?.configuration?.merchant?.capabilities;
    const recipientCap = (account as any)?.configuration?.recipient?.capabilities;

    // Verificar se a conta está ativa para receber e sacar
    const isChargesEnabled = merchantCap?.card_payments?.status === 'active' || 
                             recipientCap?.stripe_balance?.stripe_transfers?.status === 'active';
    
    const isPayoutsEnabled = merchantCap?.stripe_balance?.payouts?.status === 'active' ||
                             recipientCap?.stripe_balance?.stripe_transfers?.status === 'active';

    const readyToReceive = isChargesEnabled && isPayoutsEnabled;

    return {
      stripeAccountId: seller.stripeAccountId,
      status: readyToReceive ? 'active' : 'pending',
      chargesEnabled: isChargesEnabled,
      payoutsEnabled: isPayoutsEnabled,
    };
  }

  // ── Login Link para o Dashboard Stripe Express ─────────────────────────────

  async getLoginLink(userId: string) {
    const [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!seller || !seller.stripeAccountId) {
      throw new BadRequestException(
        'A conta Connect do vendedor não foi inicializada.',
      );
    }

    const loginLink = await this.stripeService.stripeClient.accounts.createLoginLink(
      seller.stripeAccountId,
    );

    return { url: loginLink.url };
  }

  // ── Buscar informações da conta bancária conectada ─────────────────────────

  async getExternalAccountInfo(userId: string) {
    const [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!seller || !seller.stripeAccountId) return null;

    try {
      const account = await this.stripeService.stripeClient.accounts.retrieve(
        seller.stripeAccountId,
      );

      const externalAccounts = account.external_accounts?.data || [];
      const bankAccount = externalAccounts.find(
        (acc: any) => acc.object === 'bank_account',
      );

      if (!bankAccount) return null;

      return {
        bankName: (bankAccount as any).bank_name,
        last4: (bankAccount as any).last4,
        status: (bankAccount as any).status,
      };
    } catch (error) {
      this.logger.error(`Erro ao buscar conta externa: ${error.message}`);
      return null;
    }
  }

  // ── Sync de Requirements (chamado pelo Thin Events handler) ────────────────

  async syncAccountRequirements(accountId: string) {
    this.logger.log(`Sincronizando requirements da conta: ${accountId}`);

    const [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.stripeAccountId, accountId));

    if (!seller) {
      this.logger.warn(`Nenhum seller encontrado com stripeAccountId=${accountId}. Ignorando.`);
      return;
    }

    // Buscar status atualizado da V2
    const account = await this.stripeService.stripeClient.v2.core.accounts.retrieve(
      accountId,
      { include: ['configuration.recipient', 'configuration.merchant', 'requirements'] },
    );

    const requirementsStatus =
      (account as any).requirements?.summary?.minimum_deadline?.status;
    const onboardingComplete =
      requirementsStatus !== 'currently_due' && requirementsStatus !== 'past_due';

    await this.db
      .update(schema.sellerProfiles)
      .set({
        stripeOnboardingStatus: onboardingComplete ? 'complete' : 'pending',
      })
      .where(eq(schema.sellerProfiles.id, seller.id));

    this.logger.log(
      `✅ Requirements sincronizados para seller ${seller.id}: onboarding=${onboardingComplete ? 'complete' : 'pending'}`,
    );
  }

  // ── Sync de Capability Status (chamado pelo Thin Events handler) ───────────

  async syncCapabilityStatus(accountId: string) {
    this.logger.log(`Sincronizando capability status da conta: ${accountId}`);

    const [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.stripeAccountId, accountId));

    if (!seller) {
      this.logger.warn(`Nenhum seller encontrado com stripeAccountId=${accountId}. Ignorando.`);
      return;
    }

    const account = await this.stripeService.stripeClient.v2.core.accounts.retrieve(
      accountId,
      { include: ['configuration.recipient', 'configuration.merchant'] },
    );

    const merchantCap = (account as any)?.configuration?.merchant?.capabilities;
    const recipientCap = (account as any)?.configuration?.recipient?.capabilities;

    const isChargesEnabled = merchantCap?.card_payments?.status === 'active' || 
                             recipientCap?.stripe_balance?.stripe_transfers?.status === 'active';
    
    const isPayoutsEnabled = merchantCap?.stripe_balance?.payouts?.status === 'active' ||
                             recipientCap?.stripe_balance?.stripe_transfers?.status === 'active';

    const isReadyToReceive = isChargesEnabled && isPayoutsEnabled;

    await this.db
      .update(schema.sellerProfiles)
      .set({
        stripeChargesEnabled: isChargesEnabled,
        stripePayoutsEnabled: isPayoutsEnabled,
        isVerified: isReadyToReceive,
      })
      .where(eq(schema.sellerProfiles.id, seller.id));

    this.logger.log(
      `✅ Capability status sincronizado para seller ${seller.id}: readyToReceive=${isReadyToReceive}`,
    );
  }

  // ── Legacy: Handler de evento V1 account.updated ───────────────────────────

  @OnEvent('stripe.account.updated')
  async handleAccountUpdated(account: any) {
    this.logger.log(`Sincronizando status da conta Connect (V1 event): ${account.id}`);

    const [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.stripeAccountId, account.id));

    if (!seller) {
      this.logger.warn(`Nenhum seller encontrado com stripeAccountId=${account.id}. Ignorando.`);
      return;
    }

    const isReadyToReceive = account.charges_enabled && account.payouts_enabled;

    await this.db
      .update(schema.sellerProfiles)
      .set({
        isVerified: isReadyToReceive,
        stripeChargesEnabled: isReadyToReceive,
        stripePayoutsEnabled: isReadyToReceive,
      })
      .where(eq(schema.sellerProfiles.id, seller.id));

    this.logger.log(
      `✅ Seller ${seller.id} sincronizado via V1: isVerified=${isReadyToReceive}`,
    );
  }
}
