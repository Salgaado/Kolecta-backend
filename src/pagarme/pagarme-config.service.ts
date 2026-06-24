import { Injectable } from '@nestjs/common';

/**
 * Configuração centralizada da integração Pagar.me.
 *
 * Lê tudo do ambiente e tolera valores ausentes na instanciação
 * (o erro só é lançado quando uma chamada de fato precisa da secret key),
 * para que o módulo possa subir mesmo sem credenciais configuradas ainda.
 */
@Injectable()
export class PagarmeConfigService {
  // sk_test_... (sandbox) | sk_live_... (produção)
  get secretKey(): string {
    return process.env.PAGARME_SECRET_KEY || '';
  }

  // Sandbox: https://sdx-api.pagar.me/core/v5 | Produção: https://api.pagar.me/core/v5
  get baseUrl(): string {
    return process.env.PAGARME_BASE_URL || 'https://sdx-api.pagar.me/core/v5';
  }

  // Credenciais de Basic Auth do endpoint de webhook (definidas no dashboard).
  // Pagar.me v5 não usa assinatura HMAC — a validação de origem é via Basic Auth.
  get webhookUser(): string {
    return process.env.PAGARME_WEBHOOK_USER || '';
  }

  get webhookPassword(): string {
    return process.env.PAGARME_WEBHOOK_PASSWORD || '';
  }

  // Header obrigatório em toda requisição à API Pagar.me.
  get userAgent(): string {
    return 'pagarme-skill-generated/1.0';
  }

  // HTTP Basic Auth: secret key como usuário, senha vazia → base64("sk_xxx:")
  get authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');
  }
}
