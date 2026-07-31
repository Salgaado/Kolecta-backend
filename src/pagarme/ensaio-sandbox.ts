/**
 * ENSAIO EM SANDBOX — conta nova da Pagar.me.
 *
 * Roda o ciclo inteiro que a Kolecta depende, contra a chave de TESTE da conta
 * nova, antes de qualquer `sk_live_` entrar na Render:
 *
 *   1. identidade da chave           5. cartão recusado
 *   2. recebedor "plataforma"        6. pré-autorização (o lance do leilão)
 *   3. recebedor "vendedor"          7. cancelamento da pré-auth
 *   4. compra no cartão COM split
 *
 * Reaproveita `buildRecipientPayload` de propósito: o payload exercitado aqui é
 * byte a byte o mesmo que o `RecipientsService` manda em produção. Um ensaio com
 * payload próprio provaria a Pagar.me, não a Kolecta.
 *
 * Rodar:
 *   npm run build
 *   node dist/pagarme/ensaio-sandbox.js
 *
 * Ver docs/PLAN-pagarme-conta-nova.md (bloqueio 4) e
 * docs/REF-pagarme-api.md (cartões de teste).
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { buildRecipientPayload } from '../recipients/recipient-payload';

// Host único: `sdx-api.pagar.me` está morto (404, sem rota) — confirmado
// empiricamente em 30/07. É a CHAVE que define o ambiente, não o host.
const BASE = process.env.PAGARME_BASE_URL || 'https://api.pagar.me/core/v5';
const KEY = process.env.PAGARME_SECRET_KEY || '';

// Cartões do simulador (docs/REF-pagarme-api.md). Só o número decide o desfecho.
const CARTAO_APROVA = '4000000000000010';
const CARTAO_RECUSA = '4000000000000028';

const ITEM_EM_CENTAVOS = 10000; // R$ 100,00
const COMISSAO_EM_CENTAVOS = 1100; // 11%

let falhas = 0;
const ok = (m: string) => console.log(`  ✅ ${m}`);
const falhou = (m: string) => {
  falhas++;
  console.log(`  ❌ ${m}`);
};
const titulo = (n: number, t: string) => console.log(`\n[${n}] ${t}`);

/** CPF com dígitos verificadores válidos — a Pagar.me valida de verdade. */
function cpfValido(seed: number): string {
  const base = String(seed).padStart(9, '0').slice(-9).split('').map(Number);
  const dv = (nums: number[], peso: number) => {
    const soma = nums.reduce((s, n, i) => s + n * (peso - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base, 10);
  const d2 = dv([...base, d1], 11);
  return [...base, d1, d2].join('');
}

async function api(
  metodo: string,
  caminho: string,
  corpo?: unknown,
): Promise<{ status: number; json: any }> {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: {
      Authorization: 'Basic ' + Buffer.from(KEY + ':').toString('base64'),
      'Content-Type': 'application/json',
      'User-Agent': 'kolecta-ensaio/1.0',
    },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  });
  const texto = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(texto);
  } catch {
    json = { raw: texto.slice(0, 300) };
  }
  return { status: r.status, json };
}

function erroDe(json: any): string {
  if (json?.errors) return JSON.stringify(json.errors).slice(0, 300);
  return String(json?.message ?? JSON.stringify(json)).slice(0, 300);
}

/**
 * Por que a cobrança falhou.
 *
 * A Pagar.me responde 200 com a cobrança em `failed` mesmo quando o problema é
 * o payload — um campo faltando vira "cartão recusado" aos olhos de quem só
 * olha o status. O motivo real está enterrado em `last_transaction`, e sem
 * imprimi-lo o ensaio acusa a conta por um erro que é nosso.
 */
function motivoFalha(cobranca: any): string {
  const tx = cobranca?.last_transaction;
  const gw = tx?.gateway_response;
  if (gw?.errors?.length) {
    return gw.errors.map((e: any) => e.message).join('; ');
  }
  return (
    tx?.acquirer_message ??
    tx?.gateway_response?.code ??
    cobranca?.status ??
    'motivo não informado'
  );
}

/** Recebedor PF de teste, montado pelo MESMO builder da produção. */
async function criarRecebedor(rotulo: string, seed: number) {
  const cpf = cpfValido(seed);
  const payload = buildRecipientPayload(`ensaio-${rotulo}-${Date.now()}`, {
    type: 'individual',
    document: cpf,
    name: `Ensaio ${rotulo}`,
    email: `ensaio.${rotulo}.${seed}@teste.kolecta.com.br`,
    motherName: 'Maria da Silva',
    birthdate: '1990-01-15',
    monthlyIncomeInCents: 500000,
    professionalOccupation: 'Comerciante',
    phone: '11987654321',
    address: {
      street: 'Avenida Paulista',
      streetNumber: '1000',
      neighborhood: 'Bela Vista',
      city: 'Sao Paulo',
      state: 'SP',
      zipCode: '01310100',
    },
    bankAccount: {
      holderName: `Ensaio ${rotulo}`,
      holderType: 'individual',
      holderDocument: cpf,
      bank: '001',
      branchNumber: '1234',
      branchCheckDigit: '5',
      accountNumber: '12345',
      accountCheckDigit: '6',
      accountType: 'checking',
    },
  } as any);

  const { status, json } = await api('POST', '/recipients', payload);
  if (status >= 300) {
    falhou(`recebedor "${rotulo}" recusado (${status}): ${erroDe(json)}`);
    return null;
  }
  ok(`recebedor "${rotulo}": ${json.id} · status ${json.status}`);
  return json.id as string;
}

function corpoPedido(opts: {
  cartao: string;
  split?: Array<Record<string, unknown>>;
  preAuth?: boolean;
}) {
  return {
    // `code` é obrigatório: sem ele a Pagar.me devolve 412 "The item Code is
    // required" com a cobrança em `failed` — e não como erro HTTP, o que faz
    // parecer recusa de cartão. A produção manda `listing.id` (compra) ou
    // `kolecta-bid` (lance); o ensaio segue o mesmo formato.
    items: [
      {
        amount: ITEM_EM_CENTAVOS,
        description: 'Ensaio Kolecta',
        quantity: 1,
        code: 'kolecta-ensaio',
      },
    ],
    customer: {
      name: 'Comprador Ensaio',
      email: 'comprador.ensaio@teste.kolecta.com.br',
      document: cpfValido(52998224),
      type: 'individual',
      phones: {
        mobile_phone: {
          country_code: '55',
          area_code: '11',
          number: '987654321',
        },
      },
    },
    payments: [
      {
        payment_method: 'credit_card',
        credit_card: {
          installments: 1,
          statement_descriptor: 'KOLECTA',
          ...(opts.preAuth ? { operation_type: 'auth_only' } : {}),
          card: {
            number: opts.cartao,
            holder_name: 'COMPRADOR ENSAIO',
            exp_month: 12,
            exp_year: 30,
            cvv: '123',
            // Obrigatório no cartão. Sem ele a cobrança volta `failed` com
            // `validation_error | billing | "value" is required` — de novo, um
            // erro de payload disfarçado de recusa. A produção monta este
            // objeto a partir do endereço de entrega (orders.service.ts:708).
            billing_address: {
              line_1: '1000, Avenida Paulista, Bela Vista',
              zip_code: '01310100',
              city: 'Sao Paulo',
              state: 'SP',
              country: 'BR',
            },
          },
        },
        ...(opts.split ? { split: opts.split } : {}),
      },
    ],
  };
}

async function main() {
  console.log('═══ ENSAIO EM SANDBOX — Pagar.me ═══');

  // ── 1. Identidade da chave ────────────────────────────────────────────────
  titulo(1, 'Identidade da chave');

  if (!KEY) {
    console.log('  ❌ PAGARME_SECRET_KEY ausente no .env. Abortado.');
    process.exit(1);
  }

  // A trava que dá sentido ao ensaio: com chave de produção, isto cobraria
  // cartão de verdade e criaria recebedores reais na conta da empresa.
  if (KEY.startsWith('sk_live_')) {
    console.log('  ⛔ CHAVE DE PRODUÇÃO (sk_live_) detectada. ABORTADO.');
    console.log('     Este roteiro cria recebedores e cobra cartões.');
    console.log('     Use a sk_test_ da conta nova no .env local.');
    process.exit(1);
  }
  if (!KEY.startsWith('sk_test_')) {
    console.log(
      `  ⛔ Chave em formato inesperado (${KEY.slice(0, 8)}…). Abortado.`,
    );
    process.exit(1);
  }
  ok(`chave de TESTE (${KEY.slice(0, 8)}…, ${KEY.length} chars)`);
  ok(`host ${BASE}`);

  const conta = await api('GET', '/recipients?size=1');
  if (conta.status !== 200) {
    falhou(`a chave não autentica (${conta.status}): ${erroDe(conta.json)}`);
    return resumo();
  }
  ok(
    `chave autentica · ${conta.json?.data?.length ?? 0} recebedor(es) já na conta`,
  );

  // ── 2 e 3. Recebedores ────────────────────────────────────────────────────
  titulo(2, 'Recebedor da plataforma (Kolecta)');
  const rPlataforma = await criarRecebedor('plataforma', Date.now() % 1e9);

  titulo(3, 'Recebedor do vendedor');
  const rVendedor = await criarRecebedor('vendedor', (Date.now() + 7777) % 1e9);

  if (!rPlataforma || !rVendedor) {
    console.log('\n  ⚠️  Sem os dois recebedores não dá para testar split.');
    return resumo();
  }

  const split = [
    {
      amount: ITEM_EM_CENTAVOS - COMISSAO_EM_CENTAVOS,
      type: 'flat',
      recipient_id: rVendedor,
      options: {
        liable: false,
        charge_processing_fee: false,
        charge_remainder_fee: false,
      },
    },
    {
      amount: COMISSAO_EM_CENTAVOS,
      type: 'flat',
      recipient_id: rPlataforma,
      options: {
        liable: true,
        charge_processing_fee: true,
        charge_remainder_fee: true,
      },
    },
  ];

  // ── 4. Compra aprovada com split ──────────────────────────────────────────
  titulo(4, 'Compra no cartão APROVADO, com split');
  const compra = await api(
    'POST',
    '/orders',
    corpoPedido({ cartao: CARTAO_APROVA, split }),
  );
  if (compra.status >= 300) {
    falhou(`pedido recusado (${compra.status}): ${erroDe(compra.json)}`);
  } else {
    const cobranca = compra.json?.charges?.[0];
    if (cobranca?.status === 'paid' || cobranca?.status === 'captured') {
      ok(
        `pedido ${compra.json.id} · cobrança ${cobranca.id} · ${cobranca.status}`,
      );
    } else {
      falhou(
        `cartão de APROVAÇÃO não passou (${cobranca?.status}): ${motivoFalha(cobranca)}`,
      );
    }

    const splitVolta = cobranca?.last_transaction?.split ?? cobranca?.split;
    if (!splitVolta?.length) {
      falhou('a resposta NÃO trouxe split — o dinheiro não foi dividido');
    } else {
      ok(`split aplicado em ${splitVolta.length} recebedor(es)`);
      for (const s of splitVolta) {
        console.log(
          `     · ${s.recipient_id ?? s.recipient?.id} → R$ ${(Number(s.amount) / 100).toFixed(2)}`,
        );
      }
      const soma = splitVolta.reduce(
        (t: number, s: any) => t + Number(s.amount),
        0,
      );
      soma === ITEM_EM_CENTAVOS
        ? ok(`soma do split confere: R$ ${(soma / 100).toFixed(2)}`)
        : falhou(
            `soma do split é R$ ${(soma / 100).toFixed(2)}, esperado R$ ${(ITEM_EM_CENTAVOS / 100).toFixed(2)}`,
          );
    }
  }

  // ── 5. Compra recusada ────────────────────────────────────────────────────
  titulo(5, 'Compra no cartão RECUSADO (o antifraude que derrubou julho)');
  const recusada = await api(
    'POST',
    '/orders',
    corpoPedido({ cartao: CARTAO_RECUSA, split }),
  );
  const statusRecusada =
    recusada.json?.charges?.[0]?.status ?? recusada.json?.status;
  if (
    recusada.status >= 300 ||
    ['failed', 'not_authorized'].includes(statusRecusada)
  ) {
    ok(
      `recusa tratada como esperado (status "${statusRecusada ?? recusada.status}")`,
    );
  } else {
    falhou(
      `cartão de recusa foi APROVADO (status "${statusRecusada}"). ` +
        'O simulador não está ativo nesta conta — sem ele não dá para ensaiar ' +
        'recusa, e o caminho de erro do checkout fica sem cobertura.',
    );
  }

  // ── 6 e 7. Pré-autorização: o lance do leilão ─────────────────────────────
  titulo(6, 'Pré-autorização (é assim que o lance do leilão funciona)');
  const preAuth = await api(
    'POST',
    '/orders',
    corpoPedido({ cartao: CARTAO_APROVA, split, preAuth: true }),
  );
  const cobrancaAuth = preAuth.json?.charges?.[0];
  if (preAuth.status >= 300) {
    falhou(`pré-auth recusada (${preAuth.status}): ${erroDe(preAuth.json)}`);
    console.log(
      '     ⚠️  Se disser que a operação não é permitida, a liberação',
    );
    console.log(
      '        da adquirente não chegou nesta conta — leilão fica travado.',
    );
  } else if (
    // O sinal da pré-auth está em `last_transaction.status`, NÃO em
    // `charge.status` — a API real devolve a cobrança como `pending` e a
    // transação como `authorized_pending_capture`. Conferido em 30/07.
    cobrancaAuth?.last_transaction?.status === 'authorized_pending_capture'
  ) {
    ok(
      `autorizada sem capturar: ${cobrancaAuth.id} ` +
        `(charge=${cobrancaAuth.status}, transação=${cobrancaAuth.last_transaction.status})`,
    );

    titulo(7, 'Cancelamento da pré-autorização (lance superado)');
    const cancel = await api('DELETE', `/charges/${cobrancaAuth.id}`);
    cancel.status < 300
      ? ok(`liberada: status ${cancel.json?.status}`)
      : falhou(`falha ao cancelar (${cancel.status}): ${erroDe(cancel.json)}`);
  } else {
    falhou(
      'esperado last_transaction.status "authorized_pending_capture", veio ' +
        `"${cobrancaAuth?.last_transaction?.status}": ${motivoFalha(cobrancaAuth)}`,
    );
  }

  resumo();
}

function resumo() {
  console.log('\n═══════════════════════════════════');
  if (falhas === 0) {
    console.log('✅ ENSAIO PASSOU — a conta nova está apta.');
    console.log(
      '   Próximo: Fase 2 (recebedor da plataforma) e Fase 3 (credenciais).',
    );
  } else {
    console.log(
      `❌ ENSAIO FALHOU em ${falhas} ponto(s). NÃO trocar a sk_live.`,
    );
  }
  console.log('═══════════════════════════════════');
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n💥 ERRO NÃO TRATADO:', e?.message ?? e);
  process.exit(1);
});
