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
import {
  nomeDoServico,
  parseServicos,
  servicosDaPlataforma,
  servicosDoVendedor,
} from './servicos';

/**
 * Arquivos que o Melhor Envio disponibiliza por envio.
 *
 * - `etiqueta`   → `files["1"].pdf`, só a etiqueta.
 * - `declaracao` → `files.dace.pdf`, só a declaração de conteúdo (DC-e).
 * - `completo`   → `files.dace.fullPdf`, os dois na mesma folha.
 *
 * Sim, os três já existiam desde sempre. A Kolecta entregava só o primeiro, e o
 * vendedor que despachava pelos Correios apanhava no balcão porque a declaração
 * de conteúdo é obrigatória em envio sem nota fiscal — que é todo envio daqui,
 * já que mandamos `non_commercial: true`.
 */
export type TipoArquivoEnvio = 'etiqueta' | 'declaracao' | 'completo';

/** Nome do arquivo que o vendedor baixa. Ele nunca vê a palavra "DACE". */
const NOME_DO_ARQUIVO: Readonly<Record<TipoArquivoEnvio, string>> = {
  etiqueta: 'etiqueta',
  declaracao: 'declaracao-de-conteudo',
  completo: 'etiqueta-e-declaracao',
};

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

    // Preferências do vendedor (transportadoras e retirada em mãos). Resolvidas
    // uma vez só: a retirada acompanha a resposta em TODOS os caminhos, inclusive
    // no mock, senão o checkout mostraria a opção justamente quando a cotação
    // falhou.
    const prefs = await this.preferenciasDoVendedor(listing);

    // Origem: request > endereço do vendedor (via listing) > env. Sem origem,
    // não dá pra cotar de verdade → cai no mock (o front trata como "a calcular").
    const fromCep =
      data.from_cep?.replace(/\D/g, '') ||
      (await this.resolveOriginCep(listing));
    if (!fromCep) {
      this.logger.warn(
        'CEP de origem indisponível (sem from_cep, endereço do vendedor ou SHIPPING_ORIGIN_CEP). Retornando mock.',
      );
      return this.getMockShippingQuote(prefs.aceitaRetirada);
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

      const cotadas = response.data.filter((opt: any) => !opt.error);

      // Quem manda no que aparece: a plataforma corta, e o VENDEDOR pode cortar
      // mais dentro do que sobrou (a agência perto da casa dele é o que decide
      // na prática). Ver shipping/servicos.ts.
      const permitidosIds = servicosDoVendedor(
        servicosDaPlataforma(),
        prefs.servicos,
      );

      // Filtra AQUI, e não pelo parâmetro `services` da API, de propósito: assim
      // dá para saber quantas opções o corte custou nesta rota. Pedir já
      // filtrado economizaria alguns bytes e cegaria o log.
      const permitidos = new Set(permitidosIds);
      const permitidas = permitidos.size
        ? cotadas.filter((opt: any) => permitidos.has(Number(opt.id)))
        : cotadas;

      // Mini Envios só aceita até ~300g; Loggi Express e JeT têm cobertura
      // regional. Numa rota que nenhum dos escolhidos atende, o comprador fica
      // SEM frete e não consegue fechar a compra. É silencioso do lado dele, e
      // este log é o único lugar onde isso aparece.
      if (permitidas.length === 0 && cotadas.length > 0) {
        this.logger.warn(
          `Frete ${fromCep} → ${data.to_cep}: nenhuma transportadora permitida atende. ` +
            `Permitidos: ${permitidosIds.map(nomeDoServico).join(', ') || 'nenhum'}. ` +
            `${cotadas.length} opção(ões) foram descartadas pelo filtro: ` +
            cotadas
              .map((o: any) => `${o.company?.name} ${o.name} (id ${o.id})`)
              .join(', '),
        );
      }

      const options = permitidas.map((opt: any) => ({
        carrier: opt.company.name,
        service: opt.name,
        price: parseFloat(opt.custom_price || opt.price),
        delivery_time_days: opt.custom_delivery_time || opt.delivery_time,
        raw: opt,
      }));

      return { options, pickup: prefs.aceitaRetirada };
    } catch (error: any) {
      this.logger.error(
        'Erro ao cotar frete no Melhor Envio',
        error?.response?.data || error.message,
      );
      return this.getMockShippingQuote(prefs.aceitaRetirada);
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

    // Valor declarado: o do request tem prioridade; senão o valor do ITEM.
    //
    // Era `order.totalInCents`, que é item MAIS frete: a peça ia declarada
    // valendo mais do que vale, e o seguro junto. Enquanto a declaração de
    // conteúdo era papel isso passava batido; desde 06/04/2026 o Melhor Envio
    // transmite `products` para a SEFAZ ao emitir a DC-e, então virou dado
    // fiscal declarado errado. Frete não é conteúdo do pacote.
    //
    // Cai no total se a subtração não sobrar nada: valor declarado zero faz o
    // Melhor Envio recusar o carrinho, e declarar a mais é menos ruim do que não
    // emitir a etiqueta de uma venda já paga.
    const itemInCents = order.totalInCents - (order.shippingInCents ?? 0);
    const baseInCents = itemInCents > 0 ? itemInCents : order.totalInCents;
    const declaredValue =
      dto.declared_value ?? Number((baseInCents / 100).toFixed(2));

    // O CPF do VENDEDOR não mora em `users`. Aquela coluna só é preenchida no
    // checkout, ou seja, quando a pessoa COMPRA — e vendedor que nunca comprou
    // ficava sem documento nenhum. Quem tem o dado é o cadastro de recebedor,
    // em `seller_profiles.document_number` (30 vendedores contra 9 em
    // `users.cpf`, medido em 31/07/2026). Sem esta busca, toda venda de quem só
    // vende falhava na etiqueta com "CPF do vendedor não encontrado", depois de
    // o comprador já ter pago.
    const [sellerProfile] = order.sellerId
      ? await this.db
          .select({ documentNumber: schema.sellerProfiles.documentNumber })
          .from(schema.sellerProfiles)
          .where(eq(schema.sellerProfiles.userId, order.sellerId))
      : [];

    // Falha cedo e por escrito: sem documento o Melhor Envio recusa o carrinho
    // com um erro que não diz o que fazer, e o vendedor só via "Falha ao gerar
    // etiqueta".
    const fromDoc =
      this.buildPartyDocument(dto.from_document) ??
      this.buildPartyDocument(seller?.cpf) ??
      this.buildPartyDocument(sellerProfile?.documentNumber);
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

  /**
   * Transportadoras que o dono do anúncio topa usar. `null` = não escolheu, usa
   * o conjunto da plataforma.
   *
   * Engole o erro de propósito. Migrations não são versionadas neste backend:
   * se o código subir antes do `ALTER TABLE`, esta consulta estoura com "no such
   * column" e derrubaria a COTAÇÃO, ou seja, ninguém compraria nada até alguém
   * perceber. Sem a coluna, o comportamento é o de antes.
   */
  private async servicosDoVendedorDoAnuncio(
    listing: typeof schema.listings.$inferSelect | null,
  ): Promise<number[] | null> {
    return (await this.preferenciasDoVendedor(listing)).servicos;
  }

  /**
   * Preferências de envio do dono do anúncio.
   *
   * Engole o erro de propósito. Migrations não são versionadas neste backend:
   * se o código subir antes do `ALTER TABLE`, esta consulta estoura com "no such
   * column" e derrubaria a COTAÇÃO, ou seja, ninguém compraria nada até alguém
   * perceber. Sem as colunas, o comportamento é o de antes: todas as
   * transportadoras da plataforma e retirada em mãos disponível.
   */
  private async preferenciasDoVendedor(
    listing: typeof schema.listings.$inferSelect | null,
  ): Promise<{ servicos: number[] | null; aceitaRetirada: boolean }> {
    if (!listing?.sellerId) return { servicos: null, aceitaRetirada: true };
    try {
      const [perfil] = await this.db
        .select({
          servicos: schema.sellerProfiles.shippingServices,
          aceitaRetirada: schema.sellerProfiles.acceptsPickup,
        })
        .from(schema.sellerProfiles)
        .where(eq(schema.sellerProfiles.userId, listing.sellerId));
      return {
        servicos: parseServicos(perfil?.servicos ?? null),
        // null = nunca escolheu = aceita, como sempre foi.
        aceitaRetirada: perfil?.aceitaRetirada !== false,
      };
    } catch (err: any) {
      this.logger.warn(
        `Não foi possível ler as preferências de envio do vendedor ${listing.sellerId}: ` +
          `${err?.message ?? err}. Usando o padrão da plataforma.`,
      );
      return { servicos: null, aceitaRetirada: true };
    }
  }

  /**
   * Este vendedor entrega em mãos?
   *
   * Público, porque quem precisa saber é o CHECKOUT (para mostrar ou não a
   * opção) e a criação do pedido (para recusar um pickup que o vendedor não
   * oferece). Sem a segunda, o botão da tela seria enfeite: bastava um cliente
   * antigo em cache mandar `deliveryMethod: 'pickup'` para furar.
   */
  async vendedorAceitaRetirada(sellerId: string): Promise<boolean> {
    const falso = { sellerId } as typeof schema.listings.$inferSelect;
    return (await this.preferenciasDoVendedor(falso)).aceitaRetirada;
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
   * Baixa o PDF de um pedido: etiqueta, declaração de conteúdo, ou as duas.
   *
   * A URL do `/shipment/print` NÃO serve: é página do painel, protegida por
   * sessão do Melhor Envio — o vendedor caía no login de uma conta que não é
   * dele. O arquivo de verdade está em `files` do `/me/orders/{id}`, numa URL
   * assinada da S3 que baixa sem autenticação nenhuma.
   *
   * Não guardamos o arquivo nem a URL: a assinatura expira em 30 minutos, então
   * link salvo vira link morto. Buscamos na hora, a cada download — sem cache
   * para sincronizar e sem storage para pagar.
   *
   * `contem` diz o que veio de verdade, porque o pedido nem sempre é atendido: a
   * DC-e é assíncrona no Melhor Envio e pode não existir ainda no instante em que
   * a etiqueta sai. Quem chama usa isso para nomear o arquivo e escrever o texto
   * certo, em vez de prometer uma declaração que não está no PDF.
   */
  async obterPdfDaEtiqueta(
    orderId: string,
    tipo: TipoArquivoEnvio = 'completo',
  ): Promise<{ arquivo: Buffer; nome: string; contem: TipoArquivoEnvio }> {
    const order = await this.db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });
    if (!order) throw new NotFoundException(`Pedido ${orderId} não encontrado.`);
    if (!order.shippingCartId) {
      throw new BadRequestException(
        'A etiqueta deste pedido ainda não foi emitida.',
      );
    }

    const escolhido = await this.urlDoPdfNoMelhorEnvio(
      order.shippingCartId,
      tipo,
    );
    if (!escolhido) {
      throw new BadRequestException(
        tipo === 'declaracao'
          ? 'O Melhor Envio ainda não emitiu a declaração de conteúdo deste ' +
            'envio. Ela costuma sair alguns minutos depois da etiqueta — tente ' +
            'de novo em instantes.'
          : 'O Melhor Envio ainda não disponibilizou o arquivo da etiqueta. ' +
            'Tente de novo em alguns instantes.',
      );
    }

    const resposta = await firstValueFrom(
      this.httpService.get(escolhido.url, {
        responseType: 'arraybuffer',
        timeout: 30000,
      }),
    );
    const arquivo = Buffer.from(resposta.data as ArrayBuffer);
    if (arquivo.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new HttpException(
        'O arquivo devolvido pelo Melhor Envio não é um PDF.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return {
      arquivo,
      nome: `${NOME_DO_ARQUIVO[escolhido.contem]}-${orderId.slice(0, 8)}.pdf`,
      contem: escolhido.contem,
    };
  }

  /**
   * URL assinada do PDF pedido, dentro de `files`.
   *
   * `files` vem assim (conferido em produção, 05/08/2026, em envios de Correios,
   * JeT e Loggi):
   *
   *     { "1":    { pdf, jpeg, zpl },
   *       "dace": { pdf, jpeg, zpl, fullPdf } }
   *
   * A chave "1" é a etiqueta. "dace" é o Documento Auxiliar da Declaração de
   * Conteúdo, e o `fullPdf` dele (`complete-dace.pdf`) traz etiqueta e
   * declaração na MESMA folha — uma impressão só, que é o que o vendedor quer.
   *
   * O `completo` degrada em cascata: sem `fullPdf`, tenta a etiqueta sozinha. É o
   * caso da DC-e que ainda não ficou pronta, e é melhor entregar a etiqueta do
   * que travar a postagem esperando.
   */
  private async urlDoPdfNoMelhorEnvio(
    cartId: string,
    tipo: TipoArquivoEnvio,
  ): Promise<{ url: string; contem: TipoArquivoEnvio } | null> {
    const resposta = await firstValueFrom(
      this.httpService.get(`${this.baseUrl}/orders/${cartId}`, {
        headers: this.authHeaders(),
        timeout: 20000,
      }),
    );
    const files = (resposta.data as any)?.files ?? {};
    const etiqueta = files['1']?.pdf;
    const declaracao = files?.dace?.pdf;
    const completo = files?.dace?.fullPdf;

    const preferencia: Array<[TipoArquivoEnvio, unknown]> =
      tipo === 'etiqueta'
        ? [['etiqueta', etiqueta]]
        : tipo === 'declaracao'
          ? [['declaracao', declaracao]]
          : [
              ['completo', completo],
              ['etiqueta', etiqueta],
            ];

    for (const [contem, url] of preferencia) {
      if (url) return { url: String(url), contem };
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

  private getMockShippingQuote(pickup = true) {
    return {
      pickup,
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
