import { Injectable } from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';

@Injectable()
export class DepositsService {
  constructor(private readonly stripeService: StripeService) {}

  async createCheckoutSession(orderId: string, amountInCents: number, buyerEmail?: string) {
    // Para simplificar o MVP, usamos PaymentIntents diretamente
    // ou Checkout Session caso haja redirecionamento. O plano pediu Checkout Session.
    
    // As urls de sucesso/cancel devem apontar pro FrontEnd (porta 5173 localmente ou dominio em prod)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    const session = await this.stripeService.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: buyerEmail, // Opcional, auto-preenche
      line_items: [
        {
          price_data: {
            currency: 'brl',
            product_data: {
              name: `Pedido Kolecta #${orderId.slice(0, 8)}`,
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}&order_id=${orderId}`,
      cancel_url: `${frontendUrl}/checkout/cancel?order_id=${orderId}`,
      metadata: {
        orderId,
      },
      // Salva a intent com metadata pra ser facilmente amarrada no webhook
      payment_intent_data: {
        metadata: {
          orderId,
        },
      },
    });

    return {
      sessionId: session.id,
      url: session.url,
    };
  }
}
