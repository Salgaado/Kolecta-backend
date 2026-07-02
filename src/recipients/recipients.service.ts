import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { PagarmeService } from '../pagarme/pagarme.service';
import { CreateRecipientDto } from './dto/create-recipient.dto';
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
    const payload = this.buildRecipientPayload(userId, dto);
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

  private buildRecipientPayload(userId: string, dto: CreateRecipientDto) {
    const ba = dto.bankAccount;
    const bankAccount = {
      holder_name: ba.holderName,
      holder_type: ba.holderType,
      holder_document: ba.holderDocument,
      bank: ba.bank,
      branch_number: ba.branchNumber,
      branch_check_digit: ba.branchCheckDigit,
      account_number: ba.accountNumber,
      account_check_digit: ba.accountCheckDigit,
      type: ba.accountType,
    };

    const registerInformation =
      dto.type === 'individual'
        ? {
            type: 'individual',
            document: dto.document,
            name: dto.name,
            email: dto.email,
            mother_name: dto.motherName,
            birthdate: dto.birthdate,
            // Pagar.me espera renda em reais (não centavos)
            monthly_income: dto.monthlyIncomeInCents
              ? dto.monthlyIncomeInCents / 100
              : undefined,
            professional_occupation: dto.professionalOccupation,
            phone_numbers: dto.phone
              ? [
                  {
                    ddd: dto.phone.slice(0, 2),
                    number: dto.phone.slice(2),
                    type: 'mobile',
                  },
                ]
              : undefined,
          }
        : {
            type: 'corporation',
            document: dto.document,
            company_name: dto.name,
            trading_name: dto.name,
            email: dto.email,
            phone_numbers: dto.phone
              ? [
                  {
                    ddd: dto.phone.slice(0, 2),
                    number: dto.phone.slice(2),
                    type: 'mobile',
                  },
                ]
              : undefined,
          };

    return {
      code: userId,
      register_information: registerInformation,
      default_bank_account: bankAccount,
      metadata: { userId },
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
