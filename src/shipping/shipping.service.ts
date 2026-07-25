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
import { EventEmitter2 } from '@nestjs/event-emitter';
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
    private readonly eventEmitter?: EventEmitter2,
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
   * Emite a etiqueta de um pedido a pedido do vendedor.
   *
   * NÃO usa o `service_id`/`origin_address_id` do corpo, de propósito. Quem
   * escolhe a forma de envio é o COMPRADOR, no checkout, e é ela que ele paga —
   * deixar o vendedor escolher de novo aqui permitia despachar num serviço
   * diferente do que foi cobrado, e criava um SEGUNDO carrinho (a carteira da
   * Kolecta era debitada duas vezes pelo mesmo pedido).
   *
   * Os campos continuam aceitos no DTO só para não quebrar clientes antigos.
   */
  async generateLabel(dto: GenerateLabelDto, sellerId?: string) {
    if (sellerId) {
      const order = await this.db.query.orders.findFirst({
        where: eq(schema.orders.id, dto.order_id),
      });
      if (!order) {
        throw new NotFoundException(`Pedido ${dto.order_id} não encontrado.`);
      }
      if (order.sellerId !== sellerId) {
        throw new ForbiddenException(
          'Você não tem permissão para gerar a etiqueta deste pedido.',
        );
      }
    }
    return this.emitirEtiquetaDoPedido(dto.order_id);
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
        phone: seller?.phone,
      }),
      to: this.buildParty(toAddress, {
        email: buyer?.email,
        name: toAddress.recipientName || buyer?.name,
        document: toDoc,
        phone: buyer?.phone,
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

  // ── Emissão automática da etiqueta ─────────────────────────────────────────

  /**
   * Emite a etiqueta do pedido de ponta a ponta.
   *
   * Compra direta e arremate de leilão caem aqui pelo mesmo caminho: o que muda
   * é só de onde vem o serviço (o comprador escolhe no checkout; no leilão não
   * há checkout, então cotamos e pegamos o mais barato).
   *
   * Sequência no Melhor Envio: `cart` → `checkout` (debita a carteira da
   * Kolecta) → `generate` → `print`. O PDF vai por e-mail ao REMETENTE (o
   * vendedor), que só posta.
   *
   * Idempotente por `orders.shippingCartId`: o checkout gasta dinheiro de
   * verdade, então reemitir tem que ser impossível por acidente. Chamar de novo
   * retoma de onde parou em vez de criar outro carrinho.
   *
   * Falha NUNCA é silenciosa: o motivo fica em `shippingLabelError` e o status
   * em `failed`, para o vendedor e o admin verem e poderem tentar de novo.
   * Saldo insuficiente na carteira do Melhor Envio cai exatamente aqui.
   */
  async emitirEtiquetaDoPedido(orderId: string): Promise<{
    status: string;
    cartId: string | null;
    labelUrl: string | null;
    trackingCode: string | null;
    jaEstavaPronta: boolean;
  }> {
    const order = await this.db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });
    if (!order) throw new NotFoundException(`Pedido ${orderId} não encontrado.`);

    // Já pronta: não refaz nada nem reenvia e-mail.
    if (order.shippingLabelStatus === 'ready' && order.shippingLabelUrl) {
      // Avisa mesmo já estando pronta: se o e-mail não chegou a sair (era o
      // caso do retry, que não passava por evento nenhum), esta é a chance de
      // enviar. Reenvio não acontece — o MailService é idempotente por
      // (template + refId + destinatário).
      this.avisarEtiquetaPronta(orderId, order.shippingLabelUrl);
      return {
        status: 'ready',
        cartId: order.shippingCartId ?? null,
        labelUrl: order.shippingLabelUrl,
        trackingCode: order.trackingCode ?? null,
        jaEstavaPronta: true,
      };
    }

    try {
      const cartId = order.shippingCartId ?? (await this.montarCarrinho(order));
      await this.registrarEtiqueta(orderId, { status: 'cart', cartId });

      // Retoma pelo estado REMOTO, não pelo nosso. O envio pode ter sido pago
      // ou gerado direto no painel do Melhor Envio — foi o que aconteceu na
      // primeira etiqueta de verdade: a carteira estava zerada, o dono pagou na
      // mão e o retry tentaria pagar de novo.
      const remoto = await this.consultarEnvio(cartId);

      if (!remoto?.pago) {
        await this.pagarEnvio(cartId);
      } else {
        this.logger.log(`Envio ${cartId} já estava pago no Melhor Envio.`);
      }
      await this.registrarEtiqueta(orderId, { status: 'paid', cartId });

      if (!remoto?.gerado) {
        await this.gerarEnvio(cartId);
      } else {
        this.logger.log(`Envio ${cartId} já estava gerado no Melhor Envio.`);
      }
      await this.registrarEtiqueta(orderId, { status: 'generated', cartId });

      const labelUrl = await this.imprimirEnvio(cartId);
      const trackingCode = await this.buscarRastreio(cartId);

      await this.registrarEtiqueta(orderId, {
        status: 'ready',
        cartId,
        labelUrl,
        trackingCode,
        erro: null,
      });

      this.logger.log(
        `Etiqueta emitida (pedido ${orderId}): cart ${cartId}` +
          (trackingCode ? `, rastreio ${trackingCode}` : ''),
      );
      this.avisarEtiquetaPronta(orderId, labelUrl);

      return {
        status: 'ready',
        cartId,
        labelUrl,
        trackingCode,
        jaEstavaPronta: false,
      };
    } catch (err: any) {
      const motivo = this.motivoDaFalha(err);
      await this.registrarEtiqueta(orderId, { status: 'failed', erro: motivo });
      this.logger.error(
        `Falha ao emitir etiqueta (pedido ${orderId}): ${motivo}`,
      );
      throw new HttpException(
        { message: `Falha ao emitir a etiqueta: ${motivo}`, orderId },
        err?.status && err.status < 500 ? err.status : HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Valida as duas pontas e cria o envio no carrinho.
   *
   * A validação é o ponto em que a Kolecta confere que o envio é mesmo daquela
   * compra: o endereço de destino tem que ser do COMPRADOR do pedido e o de
   * origem do VENDEDOR. Sem isso, um address_id trocado emitiria etiqueta para
   * a casa de outra pessoa.
   */
  private async montarCarrinho(
    order: typeof schema.orders.$inferSelect,
  ): Promise<string> {
    if ((order.deliveryMethod ?? 'shipping') !== 'shipping') {
      throw new BadRequestException(
        'Pedido é de retirada em mãos — não há etiqueta a emitir.',
      );
    }
    if (order.status !== 'paid') {
      throw new BadRequestException(
        `Pedido ainda não está pago (status "${order.status}") — etiqueta só depois do pagamento.`,
      );
    }
    if (!order.addressId) {
      throw new BadRequestException(
        'Pedido sem endereço de entrega — impossível montar a etiqueta.',
      );
    }

    const destino = await this.db.query.addresses.findFirst({
      where: eq(schema.addresses.id, order.addressId),
    });
    if (!destino) {
      throw new BadRequestException(
        'Endereço de entrega do pedido não encontrado.',
      );
    }
    if (destino.userId !== order.buyerId) {
      throw new BadRequestException(
        'Endereço de entrega não pertence ao comprador do pedido.',
      );
    }

    const origem = await this.enderecoDoVendedor(order.sellerId);
    if (!origem) {
      throw new BadRequestException(
        'O vendedor não tem endereço de origem cadastrado — sem ele o Melhor ' +
          'Envio não emite a etiqueta.',
      );
    }

    const listing = order.listingId
      ? await this.db.query.listings.findFirst({
          where: eq(schema.listings.id, order.listingId),
        })
      : null;

    const pacote = this.resolvePackage({} as QuoteShippingDto, listing ?? null);
    const serviceId = await this.resolverServico(order, origem, destino, pacote);

    const resultado = await this.createCart(
      {
        order_id: order.id,
        service_id: serviceId,
        origin_address_id: origem.id,
        volumes: {
          weight_kg: pacote.weight,
          width_cm: pacote.width,
          height_cm: pacote.height,
          length_cm: pacote.length,
        },
      } as GenerateLabelDto,
      // Emissão automática: quem dispara é o sistema, não o vendedor logado.
      undefined,
    );

    if (!resultado?.cartId) {
      throw new HttpException(
        'Melhor Envio não devolveu o id do envio.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return String(resultado.cartId);
  }

  /**
   * Serviço (PAC/SEDEX/Jadlog...) a usar na etiqueta.
   *
   * Na compra direta usamos o que o COMPRADOR escolheu e pagou. No leilão não
   * há checkout, então cotamos na hora e pegamos o mais barato — quem paga a
   * etiqueta é a Kolecta.
   */
  private async resolverServico(
    order: typeof schema.orders.$inferSelect,
    origem: typeof schema.addresses.$inferSelect,
    destino: typeof schema.addresses.$inferSelect,
    pacote: { weight: number; width: number; height: number; length: number },
  ): Promise<number> {
    if (order.shippingServiceId) return order.shippingServiceId;

    const cotacao = await this.quoteShipping({
      from_cep: String(origem.zip),
      to_cep: String(destino.zip),
      listing_id: order.listingId ?? undefined,
      weight_kg: pacote.weight,
      width_cm: pacote.width,
      height_cm: pacote.height,
      length_cm: pacote.length,
    } as QuoteShippingDto);

    const validas = (cotacao?.options ?? []).filter(
      (o: any) => o?.raw?.id && Number.isFinite(o.price),
    );
    if (validas.length === 0) {
      throw new BadRequestException(
        'Nenhum serviço de entrega disponível para este trajeto no Melhor Envio.',
      );
    }
    const maisBarata = validas.sort((a: any, b: any) => a.price - b.price)[0];
    this.logger.log(
      `Pedido ${order.id} sem serviço escolhido (leilão): usando ` +
        `${maisBarata.carrier} ${maisBarata.service} (R$ ${maisBarata.price}).`,
    );
    return Number(maisBarata.raw.id);
  }

  /** Endereço de origem do vendedor (padrão, ou o primeiro). */
  private async enderecoDoVendedor(sellerId: string) {
    const enderecos = await this.db
      .select()
      .from(schema.addresses)
      .where(eq(schema.addresses.userId, sellerId));
    return enderecos.find((e) => e.isDefault) ?? enderecos[0] ?? null;
  }

  /**
   * Anuncia que a etiqueta está pronta.
   *
   * O envio do PDF ficava preso no listener de `order.paid`/`auction.won`, que
   * só dispara na compra. O retry chama este serviço direto — a etiqueta saía e
   * o vendedor nunca recebia o e-mail. Agora quem emite avisa, e o e-mail
   * acontece qualquer que tenha sido o gatilho.
   */
  private avisarEtiquetaPronta(orderId: string, labelUrl: string | null): void {
    this.eventEmitter?.emit('shipping.label.ready', { orderId, labelUrl });
  }

  /**
   * Baixa o PDF da etiqueta do pedido.
   *
   * A URL do `/shipment/print` NÃO serve: é página do painel, protegida por
   * sessão do Melhor Envio — o vendedor caía no login de uma conta que não é
   * dele. O arquivo de verdade está em `files` do `/me/orders/{id}`, numa URL
   * assinada da S3 que baixa sem autenticação nenhuma.
   *
   * Não guardamos o arquivo nem a URL: a assinatura expira em 30 minutos, então
   * link salvo vira link morto. Buscamos na hora, a cada download — sem cache
   * para sincronizar e sem storage para pagar.
   */
  async obterPdfDaEtiqueta(
    orderId: string,
  ): Promise<{ arquivo: Buffer; nome: string }> {
    const order = await this.db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });
    if (!order) throw new NotFoundException(`Pedido ${orderId} não encontrado.`);
    if (!order.shippingCartId) {
      throw new BadRequestException(
        'A etiqueta deste pedido ainda não foi emitida.',
      );
    }

    const url = await this.urlDoPdfNoMelhorEnvio(order.shippingCartId);
    if (!url) {
      throw new BadRequestException(
        'O Melhor Envio ainda não disponibilizou o arquivo da etiqueta. ' +
          'Tente de novo em alguns instantes.',
      );
    }

    const resposta = await firstValueFrom(
      this.httpService.get(url, { responseType: 'arraybuffer', timeout: 30000 }),
    );
    const arquivo = Buffer.from(resposta.data as ArrayBuffer);
    if (arquivo.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new HttpException(
        'O arquivo devolvido pelo Melhor Envio não é um PDF.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return { arquivo, nome: `etiqueta-${orderId.slice(0, 8)}.pdf` };
  }

  /**
   * URL assinada do PDF da etiqueta dentro de `files`.
   *
   * `files` vem como `{ "1": { pdf, jpeg, zpl }, "dace": {...} }` — a chave "1"
   * é a etiqueta e "dace" é a declaração de conteúdo. Pegamos a etiqueta e, na
   * falta dela, qualquer entrada que tenha PDF.
   */
  private async urlDoPdfNoMelhorEnvio(cartId: string): Promise<string | null> {
    const resposta = await firstValueFrom(
      this.httpService.get(`${this.baseUrl}/orders/${cartId}`, {
        headers: this.authHeaders(),
        timeout: 20000,
      }),
    );
    const files = (resposta.data as any)?.files ?? {};
    const etiqueta = files['1']?.pdf;
    if (etiqueta) return String(etiqueta);
    for (const grupo of Object.values(files)) {
      const pdf = (grupo as any)?.pdf;
      if (pdf) return String(pdf);
    }
    return null;
  }

  /**
   * Estado do envio no Melhor Envio: já foi pago? já foi gerado?
   *
   * Sem isto a emissão só sabia o que ELA mesma tinha feito, e qualquer ação
   * pelo painel (pagar uma etiqueta na mão, por exemplo) levava o retry a
   * repetir a etapa — no caso do checkout, gastando de novo.
   *
   * Devolve null quando a consulta falha: aí seguimos o caminho normal e quem
   * decide é a própria API, que recusa duplicidade.
   */
  private async consultarEnvio(
    cartId: string,
  ): Promise<{ pago: boolean; gerado: boolean } | null> {
    try {
      const resposta = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/orders/${cartId}`, {
          headers: this.authHeaders(),
          timeout: 15000,
        }),
      );
      const d: any = resposta.data ?? {};
      // `released` = pago e aguardando geração. Os demais já passaram por lá.
      const pagos = ['released', 'generated', 'posted', 'delivered'];
      return {
        pago: !!d.paid_at || pagos.includes(d.status),
        gerado: !!d.generated_at,
      };
    } catch {
      return null;
    }
  }

  /** `POST /me/shipment/checkout` — debita a carteira da Kolecta. */
  private async pagarEnvio(cartId: string) {
    return this.postEnvio('/shipment/checkout', { orders: [cartId] });
  }

  /** `POST /me/shipment/generate` — fecha o envio e libera a impressão. */
  private async gerarEnvio(cartId: string) {
    return this.postEnvio('/shipment/generate', { orders: [cartId] });
  }

  /** `POST /me/shipment/print` — devolve a URL do PDF da etiqueta. */
  private async imprimirEnvio(cartId: string): Promise<string> {
    const data = await this.postEnvio('/shipment/print', {
      mode: 'private',
      orders: [cartId],
    });
    const url = data?.url ?? data?.[cartId]?.url ?? null;
    if (!url) {
      throw new HttpException(
        'Melhor Envio não devolveu a URL da etiqueta.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return String(url);
  }

  /**
   * Código de rastreio do envio. Best-effort: a etiqueta já está emitida, então
   * não ter o rastreio ainda não invalida nada — o e-mail sai do mesmo jeito.
   */
  private async buscarRastreio(cartId: string): Promise<string | null> {
    try {
      const data = await this.postEnvio('/shipment/tracking', {
        orders: [cartId],
      });
      const item = data?.[cartId] ?? Object.values(data ?? {})[0];
      return (item as any)?.tracking ?? null;
    } catch {
      return null;
    }
  }

  private async postEnvio(path: string, body: unknown): Promise<any> {
    const response = await firstValueFrom(
      this.httpService.post(`${this.baseUrl}${path}`, body, {
        headers: this.authHeaders(),
        timeout: 20000,
      }),
    );
    return response.data;
  }

  /** Persiste o andamento da emissão (cada etapa avança o status). */
  private async registrarEtiqueta(
    orderId: string,
    dados: {
      status: string;
      cartId?: string | null;
      labelUrl?: string | null;
      trackingCode?: string | null;
      erro?: string | null;
    },
  ) {
    const patch: Record<string, unknown> = {
      shippingLabelStatus: dados.status,
      shippingLabelAt: new Date(),
      updatedAt: new Date(),
    };
    if (dados.cartId !== undefined) patch.shippingCartId = dados.cartId;
    if (dados.labelUrl !== undefined) patch.shippingLabelUrl = dados.labelUrl;
    if (dados.trackingCode) patch.trackingCode = dados.trackingCode;
    if (dados.erro !== undefined) patch.shippingLabelError = dados.erro;

    await this.db
      .update(schema.orders)
      .set(patch)
      .where(eq(schema.orders.id, orderId));
  }

  /**
   * Mensagem legível da falha. O Melhor Envio responde erro em formatos
   * diferentes conforme a etapa, e "Falha ao gerar etiqueta" sem motivo foi
   * exatamente o que já custou tempo antes.
   */
  private motivoDaFalha(err: any): string {
    // `createCart` embrulha o erro da API em `{ message, details }`. Ler só a
    // mensagem de fora devolvia "Falha ao gerar etiqueta no Melhor Envio." e
    // jogava fora o motivo real — foi o que escondeu a exigência de telefone.
    const data =
      err?.response?.details ?? err?.response?.data ?? err?.response ?? null;
    if (typeof data?.message === 'string' && data.message) return data.message;
    if (typeof data?.error === 'string' && data.error) return data.error;
    const primeiro = data?.errors && Object.values(data.errors)[0];
    if (Array.isArray(primeiro) && primeiro[0]) return String(primeiro[0]);
    if (typeof err?.message === 'string' && err.message) return err.message;
    return 'erro desconhecido no Melhor Envio';
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

  /**
   * Telefone da ponta, só dígitos.
   *
   * Transportadoras como a JeT RECUSAM o carrinho sem ele ("O campo from.phone
   * é obrigatório quando service for 33"), enquanto Correios e Loggi aceitam —
   * foi por isso que uma etiqueta saiu e a seguinte não. Como a coluna
   * `users.phone` é recente e quase ninguém preencheu, cai no telefone de
   * contato da plataforma em vez de derrubar a venda: quem compra a etiqueta é
   * a Kolecta, então ser o contato dela no envio é defensável.
   */
  private buildPartyPhone(raw?: string | null): string {
    const digits = String(raw ?? '').replace(/\D/g, '');
    if (digits.length >= 10) return digits;
    const fallback = String(process.env.SHIPPING_FALLBACK_PHONE ?? '').replace(
      /\D/g,
      '',
    );
    return fallback.length >= 10 ? fallback : '';
  }

  private buildParty(
    addr: typeof schema.addresses.$inferSelect,
    extra: {
      email?: string | null;
      name?: string | null;
      document?: string;
      phone?: string | null;
    },
  ) {
    return {
      name: extra.name || addr.recipientName,
      email: extra.email || undefined,
      phone: this.buildPartyPhone(extra.phone),
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
    // `/carrinho`, não `/painel/carrinho`: essa segunda rota não existe e o
    // Melhor Envio devolve a página de "não encontrado" com HTTP 200 — o
    // vendedor clicava em "Abrir painel" e caía num 404. A rota certa responde
    // 302 para o login e leva ao carrinho depois de autenticar.
    return `${site}/carrinho`;
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
