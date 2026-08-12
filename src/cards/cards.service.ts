import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import {
  CARTAO_HABILITADO,
  CARTAO_INDISPONIVEL,
} from '../common/payment-flags';
import { PagarmeService } from '../pagarme/pagarme.service';
import { motivoPagarme } from '../pagarme/pagarme-erro';
import { emailUtil, nomeUtil } from '../common/cadastro-placeholder';

/** Cartão salvo, já mascarado, pronto para o frontend (sem dado sensível PCI). */
export interface MaskedCard {
  id: string;
  brand: string | null;
  lastFour: string | null;
  holderName: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/** Resposta parcial do objeto `card` da Pagar.me (POST /customers/:id/cards). */
/** Formato de telefone exigido pela Pagar.me no customer. */
interface PagarmePhones {
  mobile_phone: { country_code: string; area_code: string; number: string };
}

interface PagarmeCard {
  id: string;
  brand?: string;
  last_four_digits?: string;
  holder_name?: string;
  exp_month?: number;
  exp_year?: number;
}

interface PagarmeCustomer {
  id: string;
}

/** Endereco no formato da Pagar.me (customer.address e shipping.address). */
export interface PagarmeAddress {
  line_1: string;
  line_2?: string;
  zip_code: string;
  city: string;
  state: string;
  country: string;
}

/**
 * O que a leitura do customer remoto concluiu.
 *
 * `inexistente` é o caso da TROCA DE CONTA: o `cus_...` guardado no nosso banco
 * nasceu sob outra credencial (outra conta da Pagar.me, ou uma chave de teste
 * gravada no banco de produção) e simplesmente não existe para a chave que está
 * em uso agora. Não há o que consertar num id que não existe — o caminho é
 * descartar e criar outro.
 */
type EstadoDoCustomer = 'ok' | 'inexistente';

/**
 * Gestão do cartão salvo do usuário (usado no LANCE por cartão / pré-autorização).
 *
 * PCI: guardamos apenas o `card_id` da Pagar.me + metadados mascarados. O número
 * completo do cartão nunca passa por aqui — o front tokeniza com a chave pública
 * e nos manda só o `card_token`, que trocamos por um cartão vinculado ao
 * `customer` do usuário na Pagar.me. MVP: 1 cartão por usuário.
 */
@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly pagarme: PagarmeService,
  ) {}

  /** Retorna o cartão salvo do usuário (mascarado) ou null. */
  async getSavedCard(userId: string): Promise<MaskedCard | null> {
    const [card] = await this.db
      .select()
      .from(schema.savedCards)
      .where(eq(schema.savedCards.userId, userId));
    return card ? this.toMasked(card) : null;
  }

  /**
   * Salva (ou substitui) o cartão do usuário a partir de um `card_token`.
   * Garante um `customer` na Pagar.me, cria o cartão vinculado e persiste só o
   * `card_id` + metadados mascarados. Substitui o cartão anterior (1 por usuário).
   */
  async saveCard(
    userId: string,
    cardToken: string,
    cpf?: string,
    phone?: string,
  ): Promise<MaskedCard> {
    // Sem cartão habilitado não faz sentido guardar cartão: ele só serve para
    // lance e checkout, os dois fechados. Salvar agora daria a impressão de que
    // está tudo pronto e o lance falharia depois.
    if (!CARTAO_HABILITADO) {
      throw new BadRequestException(CARTAO_INDISPONIVEL);
    }

    // Persiste documento e telefone ANTES de garantir o customer: sem eles o
    // customer nasce incompleto e a pre-autorizacao do lance falha depois, com
    // um erro que fala de cartao e nao do dado que esta faltando.
    await this.persistCpf(userId, cpf);
    await this.persistPhone(userId, phone);
    const customerId = await this.ensureCustomer(userId);

    let created: PagarmeCard;
    try {
      created = await this.pagarme.post<PagarmeCard>(
        `/customers/${customerId}/cards`,
        { token: cardToken },
      );
    } catch (err: unknown) {
      // O motivo vem em dois formatos e o encadeamento antigo só lia um deles:
      // num erro de VALIDAÇÃO a Pagar.me indexa `errors` pelo campo, então a
      // mensagem degradava para "The request is invalid." — que diz que algo
      // está errado sem dizer o quê. `motivoPagarme` lê as duas formas.
      const detail =
        motivoPagarme(err) ||
        'Não foi possível salvar o cartão. Verifique os dados e tente novamente.';
      throw new BadRequestException(detail);
    }

    if (!created?.id) {
      throw new BadRequestException('Não foi possível salvar o cartão.');
    }

    // Substitui o cartão anterior (MVP: 1 por usuário). Remove o antigo na
    // Pagar.me para não deixar cartão órfão vinculado ao customer.
    const [existing] = await this.db
      .select()
      .from(schema.savedCards)
      .where(eq(schema.savedCards.userId, userId));

    if (existing) {
      await this.deleteRemoteCard(customerId, existing.pagarmeCardId);
      await this.db
        .delete(schema.savedCards)
        .where(eq(schema.savedCards.userId, userId));
    }

    const [row] = await this.db
      .insert(schema.savedCards)
      .values({
        userId,
        pagarmeCardId: created.id,
        brand: created.brand ?? null,
        lastFour: created.last_four_digits ?? null,
        holderName: created.holder_name ?? null,
        expMonth: created.exp_month ?? null,
        expYear: created.exp_year ?? null,
      })
      .returning();

    this.logger.log(
      `Cartão salvo p/ ${userId}: ${row.brand ?? '?'} ****${row.lastFour ?? '????'}`,
    );
    return this.toMasked(row);
  }

  /**
   * Referência interna do cartão salvo para a pré-autorização de lance:
   * `{ customerId, cardId }` ou null se o usuário não tem cartão/customer.
   * NÃO expor no controller — é dado interno de integração, não mascarado.
   */
  async getCardRef(
    userId: string,
  ): Promise<{ customerId: string; cardId: string } | null> {
    const [card] = await this.db
      .select({ cardId: schema.savedCards.pagarmeCardId })
      .from(schema.savedCards)
      .where(eq(schema.savedCards.userId, userId));
    if (!card) return null;

    const [user] = await this.db
      .select({ customerId: schema.users.pagarmeCustomerId })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (!user?.customerId) return null;

    // Auto-conserto do customer ANTES de devolver o cartao: o lance le o cartao
    // por aqui e nao passa pelo `saveCard`, entao quem ja tinha cartao salvo
    // ficaria travado para sempre sem este ponto.
    //
    // De proposito SEM guarda por campo local (ex.: "so quando users.phone
    // estiver vazio"): o que importa e o estado REMOTO, e ele pode estar
    // incompleto mesmo com o nosso banco preenchido — foi exatamente o que
    // aconteceu ao gravar o telefone na mao para destravar um vendedor. O custo
    // e um GET por lance, e `completarCadastroDoCustomer` sai na hora quando o
    // customer ja esta completo.
    //
    // Se o customer nao existe mais na conta em uso, o cartao vinculado a ele
    // tambem nao existe: devolver a dupla so adiaria a falha para dentro da
    // pre-autorizacao. Limpa e devolve null — quem chama ja sabe dizer "salve
    // um cartao no Financeiro".
    const estado = await this.completarCadastroDoCustomer(
      user.customerId,
      userId,
    );
    if (estado === 'inexistente') {
      await this.descartarCustomerMorto(userId, user.customerId);
      return null;
    }

    return { customerId: user.customerId, cardId: card.cardId };
  }

  /** Remove o cartão salvo do usuário (local + Pagar.me). */
  async removeCard(userId: string): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(schema.savedCards)
      .where(eq(schema.savedCards.userId, userId));

    if (!existing) throw new NotFoundException('Nenhum cartão salvo');

    const [user] = await this.db
      .select({ customerId: schema.users.pagarmeCustomerId })
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    if (user?.customerId) {
      await this.deleteRemoteCard(user.customerId, existing.pagarmeCardId);
    }

    await this.db
      .delete(schema.savedCards)
      .where(eq(schema.savedCards.userId, userId));
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  /**
   * Garante que o usuário tem um `customer` na Pagar.me, criando-o na primeira
   * vez e persistindo o id em `users.pagarmeCustomerId`.
   */
  /** Guarda o documento do usuario (CPF ou CNPJ, so digitos). */
  private async persistCpf(userId: string, cpf?: string) {
    const digits = String(cpf ?? '').replace(/[^0-9]/g, '');
    if (digits.length !== 11 && digits.length !== 14) return;
    await this.db
      .update(schema.users)
      .set({ cpf: digits, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  }

  /** Guarda o telefone do usuario (so digitos, DDD + numero). */
  private async persistPhone(userId: string, phone?: string) {
    const digits = String(phone ?? '').replace(/[^0-9]/g, '');
    if (digits.length < 10 || digits.length > 11) return;
    await this.db
      .update(schema.users)
      .set({ phone: digits, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  }

  /**
   * Telefone do usuario no formato da Pagar.me.
   *
   * A API EXIGE ao menos um telefone no customer para autorizar cartao ("At
   * least one customer phone is required"). O checkout ja pedia o numero, mas
   * usava inline e descartava; o lance cobra pelo `customer_id`, entao o dado
   * precisa estar gravado NO customer.
   */
  private async resolvePhone(userId: string): Promise<PagarmePhones | null> {
    const [user] = await this.db
      .select({ phone: schema.users.phone })
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    const d = String(user?.phone ?? '').replace(/[^0-9]/g, '');
    if (d.length < 10 || d.length > 11) return null;
    return {
      mobile_phone: {
        country_code: '55',
        area_code: d.slice(0, 2),
        number: d.slice(2),
      },
    };
  }

  /**
   * Documento do usuario para a Pagar.me, com o tipo certo.
   *
   * Aceita CPF (11) e CNPJ (14): a Kolecta tem lojas cadastradas como empresa,
   * e o codigo antigo forcava `individual` e so mandava documento de 11
   * digitos — o customer nascia SEM documento e a cobranca no cartao falhava
   * depois, com um erro que falava de cartao e nao de documento.
   *
   * Fonte: `users.cpf` primeiro; senao o documento do onboarding de recebedor
   * (`seller_profiles.document_number`), que muita loja ja preencheu.
   */
  private async resolveDocument(
    userId: string,
  ): Promise<{ document: string; type: 'individual' | 'company' } | null> {
    const [user] = await this.db
      .select({ cpf: schema.users.cpf })
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    const candidatos: (string | null | undefined)[] = [user?.cpf];

    const [profile] = await this.db
      .select({ doc: schema.sellerProfiles.documentNumber })
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));
    candidatos.push(profile?.doc);

    for (const bruto of candidatos) {
      const d = String(bruto ?? '').replace(/[^0-9]/g, '');
      if (d.length === 11) return { document: d, type: 'individual' };
      if (d.length === 14) return { document: d, type: 'company' };
    }
    return null;
  }

  /**
   * Endereco do usuario no formato da Pagar.me (o padrao, ou o primeiro).
   *
   * Vai gravado NO CUSTOMER, e nao na cobranca, porque quem paga com cartao
   * salvo cobra por `customer_id` — e `customer_id` e `customer` inline sao
   * mutuamente exclusivos na API. O endereco so alcanca o antifraude por aqui.
   *
   * Sem ele a transacao chega como cliente sem endereco nenhum, que e o perfil
   * de quem esta testando cartao — foi o que barrou um arremate em 12/08.
   */
  private async resolveAddress(userId: string): Promise<PagarmeAddress | null> {
    const enderecos = await this.db
      .select()
      .from(schema.addresses)
      .where(eq(schema.addresses.userId, userId));
    const end = enderecos.find((e) => e.isDefault) ?? enderecos[0];
    if (!end) return null;
    return {
      // A Pagar.me espera "numero, rua, bairro" numa linha so.
      line_1: [end.number, end.street, end.neighborhood]
        .filter(Boolean)
        .join(', '),
      ...(end.complement ? { line_2: end.complement } : {}),
      zip_code: String(end.zip).replace(/\D/g, ''),
      city: end.city,
      state: end.state,
      country: (end.country || 'BR').toUpperCase(),
    };
  }

  /**
   * Garante que um customer JA existente esteja completo E atualizado na
   * Pagar.me.
   *
   * Customers criados antes desta correcao nasceram sem documento, e a cobranca
   * no cartao falha sem ele. Recriar o customer nao serve: o cartao salvo esta
   * vinculado ao antigo e seria perdido. Entao completamos no lugar, via PUT.
   *
   * Desde 12/08 tambem conserta NOME e E-MAIL divergentes. O caso que motivou:
   * um comprador cujo customer nasceu "Novo Usuario" com e-mail
   * `@placeholder.kolecta` tinha documento e telefone em ordem, entao o reparo
   * saia na primeira linha — e o antifraude seguia avaliando um cliente que nao
   * identifica ninguem. Corrigir o cadastro no nosso banco nao bastava: a
   * Pagar.me guarda a copia dela.
   *
   * Nao derruba o fluxo se a consulta OU a escrita falhar: reparo e
   * best-effort, quem valida de verdade e a cobranca — e o erro dela agora
   * chega legivel a quem deu o lance.
   */
  private async completarCadastroDoCustomer(
    customerId: string,
    userId: string,
  ): Promise<EstadoDoCustomer> {
    let remoto: {
      document?: string | null;
      name?: string | null;
      email?: string | null;
      phones?: Record<string, unknown> | null;
      address?: Record<string, unknown> | null;
    } | null = null;
    try {
      remoto = await this.pagarme.get(`/customers/${customerId}`);
    } catch (err: unknown) {
      // 404 e o unico erro que responde a pergunta "esse id ainda vale?". Os
      // outros (rede, 5xx, timeout) nao provam nada — seguir e deixar a cobranca
      // decidir, como antes.
      if (this.statusDoErro(err) === 404) return 'inexistente';
      return 'ok';
    }

    const faltaDocumento = !remoto?.document;
    const faltaTelefone = Object.keys(remoto?.phones ?? {}).length === 0;

    // O nosso cadastro e a fonte da verdade (vem do Clerk). Lido ANTES da
    // decisao porque agora ele tambem define se ha o que consertar.
    const [user] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    const nomeLocal = nomeUtil(user?.name);
    const emailLocal = emailUtil(user?.email);

    // Endereco: o antifraude pontua com ele, e nenhum customer nosso nasceu
    // com um. So conta como pendencia quando TEMOS um para mandar — do
    // contrario o reparo escreveria a cada lance sem nunca mudar nada.
    const enderecoLocal = await this.resolveAddress(userId);
    const faltaEndereco = !remoto?.address && !!enderecoLocal;

    // Divergencia so conta quando o NOSSO lado tem dado aproveitavel: empurrar
    // "Novo Usuario" para a Pagar.me seria trocar um dado velho por um pior.
    const desatualizado =
      (!!nomeLocal && nomeLocal !== String(remoto?.name ?? '').trim()) ||
      (!!emailLocal &&
        emailLocal.toLowerCase() !==
          String(remoto?.email ?? '')
            .trim()
            .toLowerCase());

    if (!faltaDocumento && !faltaTelefone && !faltaEndereco && !desatualizado) {
      return 'ok';
    }

    const doc = await this.resolveDocument(userId);
    if (!doc) {
      // Sem documento a cobranca falha — mas so quando ele REALMENTE falta no
      // customer. Se o unico motivo era atualizar nome/e-mail/endereco,
      // bloquear o usuario por um reparo trocaria um problema por outro pior.
      if (!faltaDocumento && !faltaTelefone) return 'ok';
      throw new BadRequestException(
        'Informe seu CPF ou CNPJ para usar o cartao — a operadora exige o ' +
          'documento do titular para autorizar cobrancas.',
      );
    }

    const phones = await this.resolvePhone(userId);
    if (faltaTelefone && !phones) {
      throw new BadRequestException(
        'Informe um telefone com DDD em Financeiro > Cartao para lances — a ' +
          'operadora exige telefone do titular para autorizar cobrancas.',
      );
    }

    // O PUT da Pagar.me NAO e um patch: campo omitido nao e preservado. Por
    // isso o telefone REMOTO e reenviado quando nao temos um local — reparar o
    // nome nao pode apagar o telefone e quebrar a proxima cobranca.
    const phonesParaEnviar = phones ?? (faltaTelefone ? null : remoto?.phones);

    try {
      await this.pagarme.put(`/customers/${customerId}`, {
        // O NOSSO cadastro vem primeiro. Antes era `remoto?.name || user?.name`
        // — o remoto ganhava, entao um customer que nasceu "Novo Usuario"
        // reenviava "Novo Usuario" a cada reparo e nunca saia desse estado.
        name: nomeLocal ?? remoto?.name ?? 'Usuario Kolecta',
        email: emailLocal ?? remoto?.email,
        type: doc.type,
        document: doc.document,
        document_type: doc.type === 'company' ? 'CNPJ' : 'CPF',
        ...(phonesParaEnviar ? { phones: phonesParaEnviar } : {}),
        // Mesmo cuidado do telefone: o PUT nao e patch, entao um endereco que
        // ja exista la e reenviado em vez de sumir.
        ...(enderecoLocal
          ? { address: enderecoLocal }
          : remoto?.address
            ? { address: remoto.address }
            : {}),
      });
    } catch (err: unknown) {
      // Best-effort: falhar aqui nao pode derrubar quem so queria dar um lance.
      // Faltando documento/telefone a cobranca falha adiante com motivo
      // legivel; a divergencia de nome/e-mail tenta de novo na proxima leitura.
      this.logger.warn(
        `Reparo do customer ${customerId} falhou (ignorado): ${motivoPagarme(err)}`,
      );
      return 'ok';
    }

    await this.persistCpf(userId, doc.document);
    this.logger.log(
      `Cadastro ${desatualizado ? 'atualizado' : 'completado'} no customer ` +
        `${customerId} (user ${userId}).`,
    );
    return 'ok';
  }

  /** Status HTTP que a Pagar.me devolveu, quando der para saber. */
  private statusDoErro(err: unknown): number | null {
    const e = err as { getStatus?: () => number; status?: unknown };
    const status =
      typeof e?.getStatus === 'function' ? e.getStatus() : e?.status;
    return typeof status === 'number' ? status : null;
  }

  /**
   * Apaga a referencia a um customer que nao existe mais na conta em uso.
   *
   * O cartao salvo vai junto de proposito: ele e um `card_...` VINCULADO aquele
   * customer, entao morreu com ele. Deixar a linha para tras faria a tela dizer
   * "cartao cadastrado" e o lance falhar na hora da retencao — pior do que
   * pedir um cadastro novo.
   */
  private async descartarCustomerMorto(
    userId: string,
    customerId: string,
  ): Promise<void> {
    this.logger.warn(
      `Customer ${customerId} nao existe na conta Pagar.me atual (user ` +
        `${userId}). Descartando a referencia — provavelmente foi criado sob ` +
        'outra credencial (troca de conta ou chave de teste).',
    );
    await this.db
      .delete(schema.savedCards)
      .where(eq(schema.savedCards.userId, userId));
    await this.db
      .update(schema.users)
      .set({ pagarmeCustomerId: null, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  }

  private async ensureCustomer(userId: string): Promise<string> {
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    if (!user) throw new NotFoundException('Usuario nao encontrado');

    // Customer que JA existe pode ter nascido sem documento/telefone (o caso antes
    // desta correcao). Devolver ele direto deixaria o usuario preso: o cartao
    // salva e a cobranca falha para sempre. Completa o documento no lugar.
    //
    // E pode nao existir mais: quem guardou o `cus_...` sob a conta antiga da
    // Pagar.me ficava travado para sempre neste ponto — o GET dava 404, o erro
    // era engolido, e o POST do cartao logo abaixo falhava com um 400 que nao
    // dizia nada. Nesse caso descarta e cai no fluxo de criacao, abaixo.
    if (user.pagarmeCustomerId) {
      const estado = await this.completarCadastroDoCustomer(
        user.pagarmeCustomerId,
        userId,
      );
      if (estado === 'ok') return user.pagarmeCustomerId;
      await this.descartarCustomerMorto(userId, user.pagarmeCustomerId);
    }

    // Sem documento a Pagar.me cria o customer, mas recusa a cobranca depois.
    // Falhar aqui, dizendo o que fazer, evita o cartao "salvo" que nao paga.
    const doc = await this.resolveDocument(userId);
    if (!doc) {
      throw new BadRequestException(
        'Informe seu CPF ou CNPJ para cadastrar um cartao — a operadora exige ' +
          'o documento do titular para autorizar cobrancas.',
      );
    }

    const phones = await this.resolvePhone(userId);
    if (!phones) {
      throw new BadRequestException(
        'Informe um telefone com DDD para cadastrar um cartao — a operadora ' +
          'exige telefone do titular para autorizar cobrancas.',
      );
    }

    // Endereco ja na criacao: o antifraude pontua com ele, e um customer que
    // nasce sem obriga um PUT de reparo depois.
    const endereco = await this.resolveAddress(userId);

    const customer = await this.pagarme.post<PagarmeCustomer>('/customers', {
      name: nomeUtil(user.name) ?? 'Usuario Kolecta',
      email: emailUtil(user.email),
      type: doc.type,
      document: doc.document,
      document_type: doc.type === 'company' ? 'CNPJ' : 'CPF',
      phones,
      ...(endereco ? { address: endereco } : {}),
    });

    if (!customer?.id) {
      throw new BadRequestException(
        'Nao foi possivel registrar seus dados de pagamento. Tente novamente.',
      );
    }

    await this.db
      .update(schema.users)
      .set({ pagarmeCustomerId: customer.id, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));

    return customer.id;
  }

  /** Best-effort: remove o cartão na Pagar.me (não derruba o fluxo local). */
  private async deleteRemoteCard(
    customerId: string,
    cardId: string,
  ): Promise<void> {
    try {
      await this.pagarme.delete(`/customers/${customerId}/cards/${cardId}`);
    } catch (err: any) {
      this.logger.warn(
        `Falha ao remover cartão ${cardId} na Pagar.me (ignorado): ${err?.message}`,
      );
    }
  }

  private toMasked(card: typeof schema.savedCards.$inferSelect): MaskedCard {
    return {
      id: card.id,
      brand: card.brand,
      lastFour: card.lastFour,
      holderName: card.holderName,
      expMonth: card.expMonth,
      expYear: card.expYear,
    };
  }
}
