import { Injectable, Logger } from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';

@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(private readonly stripeService: StripeService) {}

  /**
   * Cria uma Checkout Session do Stripe para depósito na Wallet.
   * O dinheiro vai para a conta da plataforma Kolecta.
   * Após confirmação via webhook, o saldo é creditado na wallet do usuário.
   */
  async createDepositSession(userId: string, amountInCents: number) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';

    const session = await this.stripeService.stripeClient.checkout.sessions.create({
      payment_method_types: ['card', 'pix'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'brl',
            product_data: {
              name: 'Recarga de Saldo Kolecta',
              description: `Depósito de R$ ${(amountInCents / 100).toFixed(2)} na sua carteira Kolecta`,
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/painel/financeiro?deposit=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/painel/financeiro?deposit=cancelled`,
      metadata: {
        type: 'wallet_deposit',
        userId,
        amountInCents: String(amountInCents),
      },
    });

    this.logger.log(
      `Checkout Session ${session.id} criada para depósito de ${amountInCents / 100} BRL do usuário ${userId}`,
    );

    return {
      sessionId: session.id,
      url: session.url,
    };
  }
}
