import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
    kyc: KycLink;
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
      const kyc = await this.createKycLink(seller.pagarmeRecipientId);
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

    const kyc = await this.createKycLink(recipient.id);
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
    return this.createKycLink(seller.pagarmeRecipientId);
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
