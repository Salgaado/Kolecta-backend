import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PagarmeService } from '../pagarme/pagarme.service';
import { UsersService } from '../users/users.service';

/** Validade do QR Code PIX em segundos (1h). */
const PIX_EXPIRES_IN_SECONDS = 3600;

@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private readonly pagarme: PagarmeService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Cria uma cobrança PIX na Pagar.me para depósito na Wallet.
   *
   * O dinheiro entra na conta da plataforma Kolecta. O crédito na wallet do
   * usuário só acontece quando o webhook `order.paid` chega (Fase 2) — o
   * `metadata.type === 'wallet_deposit'` é o que permite o roteamento lá.
   *
   * Retorna o QR Code (imagem) + copia-e-cola para o frontend exibir.
   */
  async createDeposit(
    userId: string,
    amountInCents: number,
    cpf: string,
    phone: string,
  ) {
    const user = await this.usersService.findById(userId);

    // Telefone: DDD (2 primeiros dígitos) + número (restante).
    const areaCode = phone.slice(0, 2);
    const number = phone.slice(2);

    const payload = {
      items: [
        {
          amount: amountInCents,
          description: 'Recarga de saldo Kolecta',
          quantity: 1,
          code: 'wallet-deposit',
        },
      ],
      customer: {
        name: user.name || 'Usuário Kolecta',
        email: user.email,
        type: 'individual',
        document: cpf,
        document_type: 'CPF',
        phones: {
          mobile_phone: { country_code: '55', area_code: areaCode, number },
        },
      },
      payments: [
        {
          payment_method: 'pix',
          pix: { expires_in: PIX_EXPIRES_IN_SECONDS },
        },
      ],
      metadata: {
        type: 'wallet_deposit',
        userId,
        amountInCents: String(amountInCents),
      },
    };

    const order = await this.pagarme.post<PagarmeOrderResponse>(
      '/orders',
      payload,
      randomUUID(), // Idempotency-Key: evita cobrança dupla em retry de rede.
    );

    const charge = order.charges?.[0];
    const tx = charge?.last_transaction;

    // A Pagar.me responde HTTP 200 mesmo quando a transação falha (status no corpo).
    if (!tx?.qr_code) {
      this.logger.error(
        `Falha ao gerar PIX do depósito (order ${order.id}, status ${order.status}): ` +
          JSON.stringify(tx?.gateway_response ?? {}),
      );
      throw new BadGatewayException(
        'Não foi possível gerar o PIX no momento. Tente novamente.',
      );
    }

    this.logger.log(
      `PIX de depósito criado: order ${order.id} / R$ ${(amountInCents / 100).toFixed(2)} / user ${userId}`,
    );

    return {
      orderId: order.id,
      chargeId: charge?.id,
      status: order.status,
      amountInCents,
      qrCode: tx.qr_code, // copia-e-cola
      qrCodeUrl: tx.qr_code_url, // imagem do QR
      expiresAt: tx.expires_at,
    };
  }
}

// ── Tipagem mínima da resposta da Pagar.me usada aqui ─────────────────────────
interface PagarmeTransaction {
  qr_code?: string;
  qr_code_url?: string;
  expires_at?: string;
  status?: string;
  gateway_response?: unknown;
}

interface PagarmeCharge {
  id?: string;
  status?: string;
  last_transaction?: PagarmeTransaction;
}

interface PagarmeOrderResponse {
  id: string;
  status: string;
  charges?: PagarmeCharge[];
}
