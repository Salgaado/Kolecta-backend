import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { QuoteShippingDto, GenerateLabelDto } from './dto/shipping.dto';

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);
  private readonly baseUrl =
    process.env.MELHOR_ENVIO_API_URL ||
    'https://sandbox.melhorenvio.com.br/api/v2/me';
  private readonly token = process.env.MELHOR_ENVIO_TOKEN;

  constructor(
    private readonly httpService: HttpService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  async quoteShipping(data: QuoteShippingDto) {
    if (!this.token) {
      this.logger.warn(
        'Token do Melhor Envio não configurado. Retornando mocks para desenvolvimento.',
      );
      return this.getMockShippingQuote();
    }

    try {
      const payload = {
        from: { postal_code: data.from_cep.replace(/\D/g, '') },
        to: { postal_code: data.to_cep.replace(/\D/g, '') },
        package: {
          weight: data.weight_kg,
          width: data.width_cm,
          height: data.height_cm,
          length: data.length_cm,
        },
      };

      const response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/shipment/calculate`, payload, {
          headers: this.authHeaders(),
          timeout: 5000,
        }),
      );

      const options = response.data
        .filter((opt: any) => !opt.error)
        .map((opt: any) => ({
          carrier: opt.company.name,
          service: opt.name,
          price: parseFloat(opt.custom_price || opt.price),
          delivery_time_days: opt.custom_delivery_time || opt.delivery_time,
          raw: opt,
        }));

      return { options };
    } catch (error: any) {
      this.logger.error(
        'Erro ao cotar frete no Melhor Envio',
        error?.response?.data || error.message,
      );
      return this.getMockShippingQuote();
    }
  }

  /**
   * Gera a etiqueta (escopo "cart + link ao painel"): monta o envio real via
   * `POST /me/cart` e devolve a URL do painel Melhor Envio para o vendedor
   * pagar/imprimir lá. NÃO chama checkout (que debita saldo real da conta ME).
   *
   * Diferente da cotação, aqui NÃO há fallback mock: falta de token ou de dados
   * falha de forma visível (a etiqueta é uma ação, não uma leitura).
   */
  async generateLabel(dto: GenerateLabelDto) {
    return this.createCart(dto);
  }

  private async createCart(dto: GenerateLabelDto) {
    if (!this.token) {
      throw new HttpException(
        'Integração de etiqueta indisponível: MELHOR_ENVIO_TOKEN não configurado.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // ── Carrega o pedido e os endereços ───────────────────────────────────────
    const order = await this.db.query.orders.findFirst({
      where: eq(schema.orders.id, dto.order_id),
    });
    if (!order) {
      throw new NotFoundException(`Pedido ${dto.order_id} não encontrado.`);
    }
    if (!order.addressId) {
      throw new BadRequestException(
        'Pedido sem endereço de entrega — impossível montar a etiqueta.',
      );
    }

    const toAddress = await this.db.query.addresses.findFirst({
      where: eq(schema.addresses.id, order.addressId),
    });
    if (!toAddress) {
      throw new BadRequestException(
        'Endereço de entrega do pedido não encontrado.',
      );
    }

    const fromAddress = await this.db.query.addresses.findFirst({
      where: eq(schema.addresses.id, dto.origin_address_id),
    });
    if (!fromAddress) {
      throw new BadRequestException(
        `Endereço de origem ${dto.origin_address_id} não encontrado.`,
      );
    }

    const buyer = await this.db.query.users.findFirst({
      where: eq(schema.users.id, order.buyerId),
    });
    const seller = await this.db.query.users.findFirst({
      where: eq(schema.users.id, order.sellerId),
    });
    const listing = order.listingId
      ? await this.db.query.listings.findFirst({
          where: eq(schema.listings.id, order.listingId),
        })
      : null;

    // Valor declarado: request tem prioridade; senão total do pedido (centavos → reais)
    const declaredValue =
      dto.declared_value ?? Number((order.totalInCents / 100).toFixed(2));

    const payload = {
      service: dto.service_id,
      from: this.buildParty(fromAddress, {
        email: seller?.email,
        name: fromAddress.recipientName || seller?.name,
        document: dto.from_document,
      }),
      to: this.buildParty(toAddress, {
        email: buyer?.email,
        name: toAddress.recipientName || buyer?.name,
        document: dto.to_document,
      }),
      products: [
        {
          name: listing?.title || `Pedido ${dto.order_id.slice(0, 8)}`,
          quantity: 1,
          unitary_value: declaredValue,
        },
      ],
      volumes: [
        {
          height: dto.volumes.height_cm,
          width: dto.volumes.width_cm,
          length: dto.volumes.length_cm,
          weight: dto.volumes.weight_kg,
        },
      ],
      options: {
        insurance_value: declaredValue,
        receipt: false,
        own_hand: false,
        non_commercial: true,
      },
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/cart`, payload, {
          headers: this.authHeaders(),
          timeout: 10000,
        }),
      );

      const cart = response.data;
      this.logger.log(
        `Envio adicionado ao carrinho Melhor Envio (pedido ${dto.order_id}): cart ${cart?.id}`,
      );

      return {
        success: true,
        message:
          'Envio adicionado ao carrinho do Melhor Envio. Finalize o pagamento e imprima a etiqueta no painel.',
        cartId: cart?.id ?? null,
        protocol: cart?.protocol ?? null,
        panelUrl: this.panelUrl(),
      };
    } catch (error: any) {
      const data = error?.response?.data;
      this.logger.error(
        `Erro ao criar carrinho no Melhor Envio (pedido ${dto.order_id})`,
        data || error.message,
      );
      throw new HttpException(
        {
          message: 'Falha ao gerar etiqueta no Melhor Envio.',
          details: data ?? error.message,
        },
        error?.response?.status || HttpStatus.BAD_GATEWAY,
      );
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private authHeaders() {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'Kolecta App (contato@kolecta.com)',
    };
  }

  /** Monta um lado (from/to) do envio a partir de uma linha de `addresses`. */
  private buildParty(
    addr: typeof schema.addresses.$inferSelect,
    extra: { email?: string | null; name?: string | null; document?: string },
  ) {
    return {
      name: extra.name || addr.recipientName,
      email: extra.email || undefined,
      document: extra.document || undefined,
      address: addr.street,
      complement: addr.complement || undefined,
      number: addr.number,
      district: addr.neighborhood || undefined,
      city: addr.city,
      state_abbr: addr.state,
      country_id: addr.country || 'BR',
      postal_code: addr.zip.replace(/\D/g, ''),
    };
  }

  /** URL do painel Melhor Envio (carrinho) derivada do host da API. */
  private panelUrl() {
    const site = this.baseUrl.replace('/api/v2/me', '').replace('www.', '');
    return `${site}/painel/carrinho`;
  }

  private getMockShippingQuote() {
    return {
      options: [
        {
          carrier: 'Correios',
          service: 'PAC',
          price: 25.9,
          delivery_time_days: 7,
          raw: {},
        },
        {
          carrier: 'Correios',
          service: 'SEDEX',
          price: 45.5,
          delivery_time_days: 3,
          raw: {},
        },
      ],
    };
  }
}
