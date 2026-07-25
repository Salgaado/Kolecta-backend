import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  Inject,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
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

    // Carrega o anúncio uma vez: dele saem a origem (endereço do vendedor) e o
    // pacote persistido (peso/dimensões).
    const listing =
      (data.listing_id
        ? await this.db.query.listings.findFirst({
            where: eq(schema.listings.id, data.listing_id),
          })
        : null) ?? null;

    // Origem: request > endereço do vendedor (via listing) > env. Sem origem,
    // não dá pra cotar de verdade → cai no mock (o front trata como "a calcular").
    const fromCep =
      data.from_cep?.replace(/\D/g, '') ||
      (await this.resolveOriginCep(listing));
    if (!fromCep) {
      this.logger.warn(
        'CEP de origem indisponível (sem from_cep, endereço do vendedor ou SHIPPING_ORIGIN_CEP). Retornando mock.',
      );
      return this.getMockShippingQuote();
    }

    const pkg = this.resolvePackage(data, listing);

    try {
      const payload = {
        from: { postal_code: fromCep },
        to: { postal_code: data.to_cep.replace(/\D/g, '') },
        package: pkg,
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
  async generateLabel(dto: GenerateLabelDto, sellerId?: string) {
    return this.createCart(dto, sellerId);
  }

  private async createCart(dto: GenerateLabelDto, sellerId?: string) {
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
    // Só o vendedor dono do pedido pode gerar a etiqueta dele.
    if (sellerId && order.sellerId !== sellerId) {
      throw new ForbiddenException(
        'Você não tem permissão para gerar a etiqueta deste pedido.',
      );
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

    // Falha cedo e por escrito: sem documento o Melhor Envio recusa o carrinho
    // com um erro que não diz o que fazer, e o vendedor só via "Falha ao gerar
    // etiqueta".
    const fromDoc =
      this.buildPartyDocument(dto.from_document) ??
      this.buildPartyDocument(seller?.cpf);
    const toDoc =
      this.buildPartyDocument(dto.to_document) ??
      this.buildPartyDocument(buyer?.cpf);

    if (!fromDoc || !toDoc) {
      const quem = !fromDoc ? 'do vendedor' : 'do comprador';
      throw new BadRequestException(
        `CPF ${quem} não encontrado — o Melhor Envio exige documento nas duas ` +
          `pontas para emitir a etiqueta.`,
      );
    }

    const payload = {
      service: dto.service_id,
      // Documento (CPF/CNPJ) é OBRIGATÓRIO nos dois lados: sem ele o Melhor
      // Envio recusa o carrinho inteiro. O front não manda esses campos, então
      // caímos no CPF já guardado do usuário — o do comprador é capturado no
      // checkout (exigência da Pagar.me) e o do vendedor no cadastro.
      from: this.buildParty(fromAddress, {
        email: seller?.email,
        name: fromAddress.recipientName || seller?.name,
        document: fromDoc,
      }),
      to: this.buildParty(toAddress, {
        email: buyer?.email,
        name: toAddress.recipientName || buyer?.name,
        document: toDoc,
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

  /**
   * Resolve o CEP de origem do envio quando o request não o informa: usa o
   * endereço do vendedor dono do anúncio (preferindo o marcado como padrão) e,
   * como último recurso, o `SHIPPING_ORIGIN_CEP` do ambiente.
   */
  private async resolveOriginCep(
    listing: typeof schema.listings.$inferSelect | null,
  ): Promise<string | null> {
    if (listing) {
      const addr = await this.db.query.addresses.findFirst({
        where: eq(schema.addresses.userId, listing.sellerId),
        orderBy: (a, { desc }) => [desc(a.isDefault)],
      });
      if (addr?.zip) return addr.zip.replace(/\D/g, '');
    }
    const envCep = process.env.SHIPPING_ORIGIN_CEP?.replace(/\D/g, '');
    return envCep || null;
  }

  /**
   * Peso/dimensões do pacote a cotar. Precedência: valor do request > medidas
   * persistidas no anúncio > default por ambiente (`SHIPPING_DEFAULT_*`) >
   * pacote típico de colecionável (0,3 kg · 16×12×6 cm). Peso do anúncio é
   * armazenado em gramas (convertido para kg aqui).
   */
  private resolvePackage(
    data: QuoteShippingDto,
    listing: typeof schema.listings.$inferSelect | null,
  ) {
    const pick = (
      reqVal: number | undefined,
      listingVal: number | null | undefined,
      envKey: string,
      fallback: number,
    ) => {
      if (typeof reqVal === 'number' && !Number.isNaN(reqVal)) return reqVal;
      if (typeof listingVal === 'number' && listingVal > 0) return listingVal;
      const env = Number(process.env[envKey]);
      return Number.isFinite(env) && env > 0 ? env : fallback;
    };
    const listingWeightKg =
      listing?.weightGrams != null ? listing.weightGrams / 1000 : undefined;
    return {
      weight: pick(data.weight_kg, listingWeightKg, 'SHIPPING_DEFAULT_WEIGHT_KG', 0.3),
      width: pick(data.width_cm, listing?.widthCm, 'SHIPPING_DEFAULT_WIDTH_CM', 16),
      height: pick(data.height_cm, listing?.heightCm, 'SHIPPING_DEFAULT_HEIGHT_CM', 6),
      length: pick(data.length_cm, listing?.lengthCm, 'SHIPPING_DEFAULT_LENGTH_CM', 12),
    };
  }

  private authHeaders() {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'Kolecta App (contato@kolecta.com)',
    };
  }

  /** Monta um lado (from/to) do envio a partir de uma linha de `addresses`. */
  /** CPF/CNPJ só com dígitos; vazio vira undefined (o ME recusa string vazia). */
  private buildPartyDocument(raw?: string | null): string | undefined {
    const digits = String(raw ?? '').replace(/\D/g, '');
    return digits.length >= 11 ? digits : undefined;
  }

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
