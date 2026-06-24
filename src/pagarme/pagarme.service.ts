import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { AxiosRequestConfig } from 'axios';
import { PagarmeConfigService } from './pagarme-config.service';

/**
 * Wrapper HTTP único para a API Core v5 da Pagar.me.
 *
 * Centraliza autenticação (Basic Auth), o User-Agent obrigatório, a base URL
 * por ambiente e a chave de idempotência. Todas as chamadas (deposits, recebedores,
 * saques, compras) devem passar por aqui — não espalhar fetch/axios pelos services.
 */
@Injectable()
export class PagarmeService {
  private readonly logger = new Logger(PagarmeService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: PagarmeConfigService,
  ) {}

  // ── Métodos públicos ───────────────────────────────────────────────────────

  /**
   * @param idempotencyKey opcional — evita execução dupla acidental (ex.: criar
   *        order/transfer). Use uma chave estável por operação (ex.: `order-${id}`).
   */
  async post<T = any>(
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    return this.request<T>({
      method: 'POST',
      url: this.buildUrl(path),
      data: body,
      headers: this.buildHeaders(idempotencyKey),
    });
  }

  async get<T = any>(path: string, params?: Record<string, any>): Promise<T> {
    return this.request<T>({
      method: 'GET',
      url: this.buildUrl(path),
      params,
      headers: this.buildHeaders(),
    });
  }

  async delete<T = any>(path: string): Promise<T> {
    return this.request<T>({
      method: 'DELETE',
      url: this.buildUrl(path),
      headers: this.buildHeaders(),
    });
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  private buildHeaders(idempotencyKey?: string): Record<string, string> {
    if (!this.config.secretKey) {
      throw new Error(
        '❌ PAGARME_SECRET_KEY não está definida. Verifique seu arquivo .env',
      );
    }

    const headers: Record<string, string> = {
      Authorization: this.config.authHeader,
      'Content-Type': 'application/json',
      'User-Agent': this.config.userAgent,
    };

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return headers;
  }

  private buildUrl(path: string): string {
    const base = this.config.baseUrl.replace(/\/$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.request<T>({ timeout: 15000, ...config }),
      );
      return response.data;
    } catch (error: any) {
      const status = error?.response?.status ?? HttpStatus.BAD_GATEWAY;
      const data = error?.response?.data;

      this.logger.error(
        `Pagar.me ${config.method} ${config.url} falhou (${status})`,
        JSON.stringify(data ?? error?.message),
      );

      throw new HttpException(
        { message: 'Erro na comunicação com a Pagar.me', pagarme: data ?? null },
        typeof status === 'number' ? status : HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
