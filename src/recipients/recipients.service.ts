import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { PagarmeService } from '../pagarme/pagarme.service';
import { CreateRecipientDto } from './dto/create-recipient.dto';
import { buildRecipientPayload } from './recipient-payload';
import { isValidDocument } from './document-validation';

/** Resposta do endpoint de KYC link (prova de vida). */
export interface KycLink {
  url: string;
  qrCodeBase64: string | null;
  expiresAt: string | null;
}

/**
 * Status do recebedor na Pagar.me que significam "tudo certo, pode operar".
 * Os demais (registration, affiliation) são intermediários; refused/suspended/
 * blocked exigem ação do vendedor.
 */
const ACTIVE_STATUS = 'active';
const ACTION_NEEDED_STATUS = ['refused', 'suspended', 'blocked'];

@Injectable()
export class RecipientsService {
  private readonly logger = new Logger(RecipientsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly pagarme: PagarmeService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Onboarding: cria recebedor + gera link de KYC ──────────────────────────

  async onboard(
    userId: string,
    dto: CreateRecipientDto,
  ): Promise<{
    recipientId: string;
    status: string;
    kyc: KycLink | null;
  }> {
    // Validação de dígito verificador (a regex do DTO só valida formato)
    if (!isValidDocument(dto.document)) {
      throw new BadRequestException('CPF/CNPJ inválido (dígito verificador).');
    }
    if (!isValidDocument(dto.bankAccount.holderDocument)) {
      throw new BadRequestException('Documento do titular da conta inválido.');
    }

    const seller = await this.getOrCreateProfile(userId);

    // Já tem recebedor? Não recria — só devolve um link de KYC novo.
    if (seller.pagarmeRecipientId) {
      this.logger.log(
        `Seller ${userId} já tem recebedor ${seller.pagarmeRecipientId} — gerando novo link KYC.`,
      );
      const kyc =
        seller.pagarmeRecipientStatus === ACTIVE_STATUS
          ? null
          : await this.tryCreateKycLink(seller.pagarmeRecipientId);
      return {
        recipientId: seller.pagarmeRecipientId,
        status: seller.pagarmeRecipientStatus ?? 'registration',
        kyc,
      };
    }

    // Cria o recebedor na Pagar.me
    const payload = buildRecipientPayload(userId, dto);
    const recipient = await this.pagarme.post<{ id: string; status: string }>(
      '/recipients',
      payload,
      `recipient-${userId}`, // idempotência
    );

    this.logger.log(
      `✅ Recebedor criado para seller ${userId}: ${recipient.id} (status: ${recipient.status})`,
    );

    await this.db
      .update(schema.sellerProfiles)
      .set({
        pagarmeRecipientId: recipient.id,
        recipientType: dto.type,
        documentNumber: dto.document,
        legalName: dto.name,
        pagarmeRecipientStatus: recipient.status ?? 'registration',
        kycUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.sellerProfiles.userId, userId));

    // Recebedor que já nasce `active` não tem prova de vida pendente — pedir um
    // link de KYC para ele é uma chamada que só pode dar errado, e dava: era ela
    // que produzia o `401` no log a cada cadastro. Na conta nova a aprovação é
    // automática nesse perfil de risco (medido: PF e PJ, sandbox e produção,
    // todos `active` na resposta do próprio POST).
    const kyc =
      recipient.status === ACTIVE_STATUS
        ? null
        : await this.tryCreateKycLink(recipient.id);

    await this.recordStatus({
      userId,
      recipientId: recipient.id,
      status: recipient.status,
      source: 'onboard',
      kycLinkIssued: kyc !== null,
    });

    return { recipientId: recipient.id, status: recipient.status, kyc };
  }

  // ── Status / KYC link sob demanda ──────────────────────────────────────────

  async getStatus(userId: string) {
    const [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!seller || !seller.pagarmeRecipientId) {
      return {
        onboarded: false,
        status: 'not_started',
        canReceive: false,
        canWithdraw: false,
      };
    }

    return {
      onboarded: true,
      recipientId: seller.pagarmeRecipientId,
      status: seller.pagarmeRecipientStatus,
      canReceive: seller.canReceive,
      canWithdraw: seller.canWithdraw,
      document: maskDocument(seller.documentNumber),
    };
  }

  /**
   * Link de KYC sob demanda — o botão "Gerar novo link de verificação".
   *
   * A emissão depende de `POST /recipients/{id}/kyc_link`, que na conta nova
   * responde `401 "IP de origem não autorizado"`: a allowlist de operações
   * sensíveis não foi replicada na virada de conta (ver
   * `docs/PLAN-pagarme-conta-nova.md`). Repassar esse erro cru punha infraestrutura
   * num toast vermelho na tela do vendedor — para um problema que ele não tem
   * como resolver e que, pior, o faz achar que está travado.
   *
   * **Ele não está.** Medido, não suposto: os 6 recebedores criados na conta
   * nova desde a virada estão TODOS `active`, e o link nunca foi emitido uma
   * única vez no período (`scripts/diagnostico-kyc-conta-nova.ts`). Mais: o
   * `recipient.created` chega ~11s depois do cadastro já com `active`, rápido
   * demais para prova de vida humana — a Pagar.me está aprovando sozinha nesse
   * perfil de risco. O link é um atalho para o caso que precisar, não o caminho.
   *
   * Então a falha vira 503 dizendo isso, em vez do erro do gateway. O motivo
   * técnico continua inteiro no log do `PagarmeService`.
   */
  async getKycLink(userId: string): Promise<KycLink> {
    const [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!seller?.pagarmeRecipientId) {
      throw new NotFoundException(
        'Recebedor ainda não criado para este vendedor.',
      );
    }

    // Quem já está ativo não tem prova de vida a fazer. A tela chegava aqui por
    // status velho (o KYC é aprovado ~11s depois, por webhook, e o vendedor
    // continuava vendo "Verificação pendente"), então a chamada ia à Pagar.me
    // só para voltar erro. Responde o que é verdade, sem sair daqui.
    if (seller.pagarmeRecipientStatus === ACTIVE_STATUS) {
      throw new ConflictException(
        'Seu cadastro já foi aprovado — não é preciso fazer a prova de vida. ' +
          'Atualize a página para ver o status novo.',
      );
    }

    try {
      return await this.createKycLink(seller.pagarmeRecipientId);
    } catch {
      throw new ServiceUnavailableException(
        'Não foi possível gerar o link de verificação agora, mas seu cadastro ' +
          'está salvo e em análise. Na maioria dos casos a Pagar.me aprova em ' +
          'poucos instantes, sem precisar do link — esta tela avisa sozinha ' +
          'quando isso acontecer. Não é preciso preencher nada de novo.',
      );
    }
  }

  // ── Sync vindo do webhook recipient.updated ────────────────────────────────

  /**
   * Escuta o evento emitido pelo webhook unificado (`PagarmeWebhookController`
   * em `pagarme/`) para `recipient.created`/`recipient.updated`. Usamos evento
   * (e não injeção direta do controller) porque `RecipientsModule` importa
   * `PagarmeModule` — chamar este service de dentro do webhook criaria
   * dependência circular. O payload é o `data` do evento Pagar.me.
   */
  @OnEvent('pagarme.recipient.updated')
  async onRecipientUpdated(data: { id?: string; status?: string }): Promise<void> {
    if (!data?.id || !data?.status) {
      this.logger.warn(
        'Evento pagarme.recipient.updated sem id/status no payload — ignorado.',
      );
      return;
    }
    await this.syncRecipientStatus(data.id, data.status);
  }

  async syncRecipientStatus(
    recipientId: string,
    status: string,
  ): Promise<void> {
    const [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.pagarmeRecipientId, recipientId));

    if (!seller) {
      this.logger.warn(
        `Webhook recipient.updated para ${recipientId} sem seller correspondente.`,
      );
      return;
    }

    const canOperate = status === ACTIVE_STATUS;
    await this.db
      .update(schema.sellerProfiles)
      .set({
        pagarmeRecipientStatus: status,
        canReceive: canOperate,
        canWithdraw: canOperate,
        // Mantém o flag manual da equipe em sincronia com o KYC automático
        isVerified: canOperate ? true : seller.isVerified,
        kycUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.sellerProfiles.id, seller.id));

    this.logger.log(
      `Recebedor ${recipientId} (seller ${seller.userId}) → status ${status}`,
    );

    await this.recordStatus({
      userId: seller.userId,
      recipientId,
      status,
      source: 'webhook',
    });

    // O leilão do vendedor ficou pausado enquanto ele não podia receber: lance
    // exige recebedor ativo, então relógio correndo sem isso só produziria
    // "vendedor não está apto" na cara do comprador. Agora que ele pode, os
    // leilões dele voltam sozinhos, com o tempo que faltava.
    //
    // Idempotente por construção: quem retoma só olha leilão pausado, então
    // `recipient.updated` repetido não mexe em nada.
    if (canOperate) {
      this.eventEmitter.emit('seller.apto-a-receber', {
        sellerId: seller.userId,
      });
    }

    // Notifica o vendedor por e-mail nos estados relevantes
    const [user] = await this.db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, seller.userId));

    if (status === ACTIVE_STATUS) {
      this.eventEmitter.emit('recipient.kyc.approved', {
        userId: seller.userId,
        email: user?.email ?? '',
        name: user?.name ?? null,
      });
    } else if (ACTION_NEEDED_STATUS.includes(status)) {
      this.eventEmitter.emit('recipient.kyc.action_needed', {
        userId: seller.userId,
        email: user?.email ?? '',
        name: user?.name ?? null,
        status,
      });
    }
  }

  /** Helper para outros módulos: o vendedor pode receber pagamentos? */
  async canReceive(userId: string): Promise<boolean> {
    const [seller] = await this.db
      .select({ canReceive: schema.sellerProfiles.canReceive })
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));
    return !!seller?.canReceive;
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  private async getOrCreateProfile(userId: string) {
    const [seller] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));
    if (seller) return seller;

    const [created] = await this.db
      .insert(schema.sellerProfiles)
      .values({ userId, pagarmeRecipientStatus: 'not_started' })
      .returning();
    return created;
  }

  /**
   * Versão tolerante do link de KYC, usada no `onboard`.
   *
   * O cadastro são duas chamadas à Pagar.me: `POST /recipients` (que cria o
   * recebedor de verdade, dispara o e-mail de conta ativa e é gravada aqui) e
   * `POST /recipients/{id}/kyc_link`. Deixar a segunda derrubar o request
   * inteiro produz o pior resultado possível: o vendedor vê "Erro ao cadastrar
   * recebedor" para um cadastro que **deu certo** — e pior, fica preso, porque
   * toda nova tentativa cai no ramo "já tem recebedor" acima, que não recria
   * nada e só refaz justamente a chamada que falha.
   *
   * Foi o que aconteceu em 31/07: o `kyc_link` voltou 401 "IP de origem não
   * autorizado" (allowlist da conta nova) e vendedores com recebedor criado
   * repetiam o mesmo erro vermelho sem saída. O link é reemitível a qualquer
   * momento pelo botão da tela — perdê-lo nunca justifica descartar o cadastro.
   */
  private async tryCreateKycLink(recipientId: string): Promise<KycLink | null> {
    try {
      return await this.createKycLink(recipientId);
    } catch (error: any) {
      this.logger.error(
        `Recebedor ${recipientId} sem link de KYC (a emissão falhou) — ` +
          `cadastro mantido, vendedor gera o link depois.`,
        JSON.stringify(error?.response ?? error?.message ?? error),
      );
      return null;
    }
  }

  /**
   * Anota, sem poder falhar, o que a Pagar.me disse sobre o recebedor.
   *
   * `seller_profiles` guarda só o estado atual — é sobrescrito a cada webhook —
   * então sem isto não sobra prova de que ELES devolveram `active`. Importa
   * porque na conta nova o recebedor é aprovado sem que o link de KYC seja
   * emitido: se a prova de vida for cobrada retroativamente, esta tabela é a
   * evidência. Ver `scripts/add-recipient-status-history.ts`.
   *
   * **Fail-open, deliberadamente.** É trilha de auditoria: perder uma linha é
   * ruim, mas derrubar o cadastro de um vendedor por causa dela é pior — e a
   * tabela é nova, então um ambiente sem ela não pode quebrar o onboarding.
   * Mesma régua do `email_log` em `mail.service.ts`.
   */
  private async recordStatus(entry: {
    userId: string;
    recipientId: string;
    status: string;
    source: 'onboard' | 'webhook';
    kycLinkIssued?: boolean;
  }): Promise<void> {
    try {
      await this.db.insert(schema.recipientStatusHistory).values({
        userId: entry.userId,
        recipientId: entry.recipientId,
        status: entry.status,
        source: entry.source,
        kycLinkIssued: entry.kycLinkIssued ?? null,
      });
    } catch (err: any) {
      this.logger.debug(
        `recipient_status_history insert falhou (${entry.recipientId} → ${entry.status}): ${
          err?.message ?? err
        }`,
      );
    }
  }

  private async createKycLink(recipientId: string): Promise<KycLink> {
    const res = await this.pagarme.post<{
      url: string;
      base64_qrcode?: string;
      expires_at?: string;
    }>(`/recipients/${recipientId}/kyc_link`, {});
    return {
      url: res.url,
      qrCodeBase64: res.base64_qrcode ?? null,
      expiresAt: res.expires_at ?? null,
    };
  }

}

/** Mascara CPF/CNPJ para exibição (LGPD): mostra só os últimos 2 dígitos. */
function maskDocument(doc: string | null): string | null {
  if (!doc) return null;
  return doc.length <= 2
    ? doc
    : `${'*'.repeat(doc.length - 2)}${doc.slice(-2)}`;
}
