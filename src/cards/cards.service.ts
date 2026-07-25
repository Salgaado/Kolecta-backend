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
import { PagarmeService } from '../pagarme/pagarme.service';

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
  ): Promise<MaskedCard> {
    // Persiste o CPF ANTES de garantir o customer: sem documento, o customer
    // nasce incompleto e a pre-autorizacao do lance falha depois, com um erro
    // que fala de cartao e nao de documento.
    await this.persistCpf(userId, cpf);
    const customerId = await this.ensureCustomer(userId);

    let created: PagarmeCard;
    try {
      created = await this.pagarme.post<PagarmeCard>(
        `/customers/${customerId}/cards`,
        { token: cardToken },
      );
    } catch (err: any) {
      const detail =
        err?.response?.pagarme?.errors?.[0]?.message ||
        err?.response?.message ||
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
      .select({
        customerId: schema.users.pagarmeCustomerId,
        cpf: schema.users.cpf,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (!user?.customerId) return null;

    // Auto-conserto: `users.cpf` vazio e o sinal de que o customer nasceu SEM
    // documento (antes desta correcao) e a cobranca falharia. Como o lance le o
    // cartao por aqui e nao passa pelo `saveCard`, completamos neste ponto —
    // senao quem ja tinha cartao salvo ficaria travado para sempre. Depois do
    // PUT o CPF fica gravado e esta checagem nao repete.
    if (!user.cpf) {
      await this.completarDocumentoDoCustomer(user.customerId, userId);
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
   * Garante que um customer JA existente tenha documento na Pagar.me.
   *
   * Customers criados antes desta correcao nasceram sem documento, e a cobranca
   * no cartao falha sem ele. Recriar o customer nao serve: o cartao salvo esta
   * vinculado ao antigo e seria perdido. Entao completamos no lugar, via PUT.
   *
   * Nao derruba o fluxo se a consulta falhar: se o customer ja estiver correto
   * ou a Pagar.me responder outra coisa, seguimos — quem valida de verdade e a
   * cobranca, e o erro dela agora chega legivel a quem deu o lance.
   */
  private async completarDocumentoDoCustomer(
    customerId: string,
    userId: string,
  ): Promise<void> {
    let remoto: {
      document?: string | null;
      name?: string | null;
      email?: string | null;
    } | null = null;
    try {
      remoto = await this.pagarme.get(`/customers/${customerId}`);
    } catch {
      return; // sem leitura, deixa a cobranca decidir
    }
    if (remoto?.document) return; // ja tem documento

    const doc = await this.resolveDocument(userId);
    if (!doc) {
      throw new BadRequestException(
        'Informe seu CPF ou CNPJ para usar o cartao — a operadora exige o ' +
          'documento do titular para autorizar cobrancas.',
      );
    }

    // O PUT da Pagar.me NAO e um patch: sem `name` ele responde 422 ("The name
    // field is required"). Reenviamos os campos que ja existem no customer,
    // caindo no nosso cadastro quando o remoto vier vazio.
    const [user] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    await this.pagarme.put(`/customers/${customerId}`, {
      name: remoto?.name || user?.name || 'Usuario Kolecta',
      email: remoto?.email || user?.email,
      type: doc.type,
      document: doc.document,
      document_type: doc.type === 'company' ? 'CNPJ' : 'CPF',
    });
    await this.persistCpf(userId, doc.document);
    this.logger.log(
      `Documento completado no customer ${customerId} (user ${userId}).`,
    );
  }

  private async ensureCustomer(userId: string): Promise<string> {
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    if (!user) throw new NotFoundException('Usuario nao encontrado');

    // Customer que JA existe pode ter nascido sem documento (era o caso antes
    // desta correcao). Devolver ele direto deixaria o usuario preso: o cartao
    // salva e a cobranca falha para sempre. Completa o documento no lugar.
    if (user.pagarmeCustomerId) {
      await this.completarDocumentoDoCustomer(user.pagarmeCustomerId, userId);
      return user.pagarmeCustomerId;
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

    const customer = await this.pagarme.post<PagarmeCustomer>('/customers', {
      name: user.name || 'Usuario Kolecta',
      email: user.email,
      type: doc.type,
      document: doc.document,
      document_type: doc.type === 'company' ? 'CNPJ' : 'CPF',
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
