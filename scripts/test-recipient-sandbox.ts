/**
 * E2E sandbox — criação de recebedor (Fase 0.3 do docs/PLAN-wallet-split.md).
 *
 * Valida o `CreateRecipientDto` (class-validator), monta o payload com a MESMA
 * função pura do service (`buildRecipientPayload`) e opcionalmente dispara o
 * `POST /recipients` real na Pagar.me. Assim confirmamos que o contrato novo
 * (PF `address`+`site_url`; PJ `main_address`+`managing_partners`) é aceito.
 *
 * Uso:
 *   npx ts-node scripts/test-recipient-sandbox.ts            # dry-run (só imprime o payload)
 *   npx ts-node scripts/test-recipient-sandbox.ts --run      # cria de verdade na sandbox
 *   npx ts-node scripts/test-recipient-sandbox.ts --run --pj # testa o fluxo Pessoa Jurídica
 *
 * Segurança: recusa rodar `--run` se a chave não for sk_test_ (evita criar
 * recebedor em produção por engano).
 */
import 'reflect-metadata';
import 'dotenv/config';
import axios from 'axios';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRecipientDto } from '../src/recipients/dto/create-recipient.dto';
import { buildRecipientPayload } from '../src/recipients/recipient-payload';

const RUN = process.argv.includes('--run');
const PJ = process.argv.includes('--pj');

// CPF/CNPJ de teste da própria doc da Pagar.me (válidos no dígito verificador).
const SAMPLE_PF: Record<string, unknown> = {
  type: 'individual',
  name: 'Recebedor Pessoa Fisica',
  document: '26224451990',
  email: 'pf-teste@kolecta.com.br',
  siteUrl: 'https://kolecta.com.br',
  phone: '21994647568',
  motherName: 'Maria da Silva',
  birthdate: '1990-10-02',
  monthlyIncomeInCents: 300000, // R$ 3.000,00
  professionalOccupation: 'Vendedor',
  address: {
    street: 'Av. General Justo',
    streetNumber: '375',
    neighborhood: 'Centro',
    city: 'Rio de Janeiro',
    state: 'RJ',
    zipCode: '20021130',
    complementary: 'Bloco A',
    referencePoint: 'Ao lado da banca de jornal',
  },
  bankAccount: {
    holderName: 'Recebedor Pessoa Fisica',
    holderType: 'individual',
    holderDocument: '26224451990',
    bank: '341',
    branchNumber: '1234',
    branchCheckDigit: '6',
    accountNumber: '12345',
    accountCheckDigit: '6',
    accountType: 'checking',
  },
};

const SAMPLE_PJ: Record<string, unknown> = {
  type: 'company',
  name: 'Kolecta Marketplace LTDA',
  document: '77699131000133',
  email: 'pj-teste@kolecta.com.br',
  siteUrl: 'https://kolecta.com.br',
  phone: '21994647568',
  annualRevenueInCents: 100000000, // R$ 1.000.000,00
  corporationType: 'LTDA',
  foundingDate: '2010-10-30',
  mainAddress: {
    street: 'Av. General Justo',
    streetNumber: '375',
    neighborhood: 'Centro',
    city: 'Rio de Janeiro',
    state: 'RJ',
    zipCode: '20021130',
    complementary: 'Bloco A',
    referencePoint: 'Ao lado da banca de jornal',
  },
  managingPartners: [
    {
      name: 'Tony Stark',
      email: 'tstark@kolecta.com.br',
      document: '26224451990',
      motherName: 'Nome da mae',
      birthdate: '1995-10-12',
      monthlyIncomeInCents: 1200000, // R$ 12.000,00
      professionalOccupation: 'Socio administrador',
      selfDeclaredLegalRepresentative: true,
      phone: '27999992628',
      address: {
        street: 'Av. General Justo',
        streetNumber: '375',
        neighborhood: 'Centro',
        city: 'Rio de Janeiro',
        state: 'RJ',
        zipCode: '20021130',
        complementary: 'Bloco A',
        referencePoint: 'Ao lado da banca de jornal',
      },
    },
  ],
  bankAccount: {
    holderName: 'Kolecta Marketplace LTDA',
    holderType: 'company',
    holderDocument: '77699131000133',
    bank: '341',
    branchNumber: '1234',
    branchCheckDigit: '6',
    accountNumber: '12345',
    accountCheckDigit: '6',
    accountType: 'checking',
  },
};

async function main() {
  const raw = PJ ? SAMPLE_PJ : SAMPLE_PF;
  const dto = plainToInstance(CreateRecipientDto, raw);

  // 1) valida como o ValidationPipe global faria
  const errors = await validate(dto, { whitelist: true });
  if (errors.length) {
    console.error('❌ DTO inválido:');
    console.error(JSON.stringify(errors, null, 2));
    process.exit(1);
  }
  console.log(`✅ DTO ${PJ ? 'PJ' : 'PF'} válido.`);

  // 2) monta o payload real (code único por execução — evita colisão em sandbox)
  const payload = buildRecipientPayload(
    `sandbox-${PJ ? 'pj' : 'pf'}-${Date.now()}`,
    dto,
  );
  console.log('\n── Payload POST /recipients ──');
  console.log(JSON.stringify(payload, null, 2));

  if (!RUN) {
    console.log('\nℹ️  Dry-run. Rode com --run para criar de verdade na sandbox.');
    return;
  }

  // 3) guarda de segurança: só sandbox
  const key = process.env.PAGARME_SECRET_KEY || '';
  if (!key.startsWith('sk_test')) {
    console.error(
      `❌ PAGARME_SECRET_KEY não é de teste (${key.slice(0, 8)}...). Abortando para não criar recebedor em produção.`,
    );
    process.exit(1);
  }

  const baseUrl = (
    process.env.PAGARME_BASE_URL || 'https://api.pagar.me/core/v5'
  ).replace(/\/$/, '');

  console.log(`\n🚀 POST ${baseUrl}/recipients (sandbox)...`);
  try {
    const res = await axios.post(`${baseUrl}/recipients`, payload, {
      auth: { username: key, password: '' },
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'pagarme-skill-generated/1.0',
        'Idempotency-Key': `recipient-sandbox-${PJ ? 'pj' : 'pf'}-${Date.now()}`,
      },
      timeout: 20000,
    });
    console.log('\n✅ Recebedor criado:');
    console.log(
      JSON.stringify(
        { id: res.data.id, status: res.data.status, type: res.data.type },
        null,
        2,
      ),
    );
    console.log('\nStatus esperado: registration/affiliation → prova de vida → active.');
  } catch (err: any) {
    console.error(`\n❌ Falhou (${err?.response?.status}):`);
    console.error(JSON.stringify(err?.response?.data ?? err.message, null, 2));
    process.exit(1);
  }
}

main();
