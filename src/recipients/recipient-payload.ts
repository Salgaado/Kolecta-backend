import { AddressDto, CreateRecipientDto } from './dto/create-recipient.dto';

/**
 * Monta o corpo do `POST /recipients` da Pagar.me a partir do DTO de onboarding.
 *
 * Função PURA (sem estado/DB) para ser reutilizada tanto pelo `RecipientsService`
 * quanto por scripts de teste E2E — assim o payload validado em sandbox é
 * exatamente o que roda em produção. Segue o contrato de recebedores da Pagar.me
 * (Circular BCB 3.978/20, fev/2024): PF envia `address`; PJ envia `main_address`
 * + `managing_partners[]`. `transfer_enabled:false` é o mecanismo de retenção
 * (o repasse é disparado pela plataforma via /transfers após a janela).
 */
export function buildRecipientPayload(userId: string, dto: CreateRecipientDto) {
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
          site_url: dto.siteUrl,
          mother_name: dto.motherName,
          birthdate: toBrDate(dto.birthdate),
          // Pagar.me espera renda em reais (não centavos)
          monthly_income: toReais(dto.monthlyIncomeInCents),
          professional_occupation: dto.professionalOccupation,
          address: toAddress(dto.address),
          phone_numbers: toPhoneNumbers(dto.phone),
        }
      : {
          type: 'corporation',
          document: dto.document,
          // company_name = nome fantasia; trading_name = razão social
          company_name: dto.name,
          trading_name: dto.name,
          email: dto.email,
          site_url: dto.siteUrl,
          annual_revenue: toReais(dto.annualRevenueInCents),
          corporation_type: dto.corporationType,
          founding_date: dto.foundingDate,
          main_address: toAddress(dto.mainAddress),
          managing_partners: (dto.managingPartners ?? []).map((p) => ({
            name: p.name,
            email: p.email,
            document: p.document,
            type: 'individual',
            mother_name: p.motherName,
            birthdate: toBrDate(p.birthdate),
            monthly_income: toReais(p.monthlyIncomeInCents),
            professional_occupation: p.professionalOccupation,
            self_declared_legal_representative:
              p.selfDeclaredLegalRepresentative,
            address: toAddress(p.address),
            phone_numbers: toPhoneNumbers(p.phone),
          })),
          phone_numbers: toPhoneNumbers(dto.phone),
        };

  return {
    code: userId,
    register_information: registerInformation,
    default_bank_account: bankAccount,
    // Retenção (buyer protection): NÃO liberar o payout automaticamente.
    // O repasse ao vendedor é disparado pela plataforma via /transfers após
    // a janela de proteção (ver docs/PLAN-wallet-split.md, Fase 4/5).
    // `transfer_interval`/`transfer_day` são exigidos pela Pagar.me mesmo com
    // `transfer_enabled:false` (422 sem eles); ficam inertes enquanto desligado.
    transfer_settings: {
      transfer_enabled: false,
      transfer_interval: 'Daily',
      transfer_day: 0,
    },
    metadata: { userId },
  };
}

/**
 * ISO `YYYY-MM-DD` → `DD/MM/YYYY`. O campo `birthdate` do recebedor exige esse
 * formato (a Pagar.me valida com regex e rejeita ISO). `founding_date` (PJ), por
 * outro lado, aceita ISO — por isso a conversão é só aqui.
 */
function toBrDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Centavos → reais (a Pagar.me espera renda/receita em reais, não centavos). */
function toReais(cents: number | undefined): number | undefined {
  return typeof cents === 'number' ? Math.round(cents) / 100 : undefined;
}

/** Telefone "DDNNNNNNNNN" → formato phone_numbers[] da Pagar.me. */
function toPhoneNumbers(phone: string | undefined) {
  if (!phone) return undefined;
  return [{ ddd: phone.slice(0, 2), number: phone.slice(2), type: 'mobile' }];
}

/** AddressDto → objeto address/main_address snake_case da Pagar.me. */
function toAddress(addr: AddressDto | undefined) {
  if (!addr) return undefined;
  return {
    street: addr.street,
    street_number: addr.streetNumber,
    neighborhood: addr.neighborhood,
    city: addr.city,
    state: addr.state.toUpperCase(),
    zip_code: addr.zipCode,
    // Mesma exigência do `reference_point` abaixo, e pela mesma razão: string
    // vazia conta como ausente e a Pagar.me devolve 422 "The complementary
    // field is required". Endereço sem complemento é o caso comum (casa, e não
    // apartamento), então o `?? ''` daqui barrava exatamente o vendedor mais
    // típico. Encontrado pelo ensaio em sandbox antes de chegar em produção.
    complementary: addr.complementary?.trim() || 'Não informado',
    // Pagar.me EXIGE reference_point não-vazio (string vazia = "field is required"
    // → 422). Quando o vendedor não informa, mandamos um marcador não-vazio.
    reference_point: addr.referencePoint?.trim() || 'Não informado',
  };
}
