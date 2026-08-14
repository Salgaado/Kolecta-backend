import {
  Injectable,
  Inject,
  BadRequestException,
  BadGatewayException,
  Logger,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import { PagarmeService } from '../pagarme/pagarme.service';
import { WalletService } from '../wallet/wallet.service';
import * as schema from '../database/schema';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';
import { motivoPagarme } from '../pagarme/pagarme-erro';
import {
  WITHDRAWAL_MIN_CENTS,
  WITHDRAWAL_FEE_CENTS,
  calcMaxWithdrawableInCents,
} from '../common/withdrawal-fees';

/** Consulta de saldo roda na abertura do diálogo de saque — não pode travar a tela. */
const BALANCE_TIMEOUT_MS = 4000;

/** Resposta mínima do POST /transfers da Pagar.me. */
interface PagarmeTransfer {
  id: string;
  status?: string;
}

/** Resposta do GET /recipients/{id}/balance (sondado em 13/08/2026). */
interface PagarmeRecipientBalance {
  currency?: string;
  /** Disponível para transferir agora. Em centavos. */
  available_amount?: number;
  /** Ainda não liquidado — NÃO entra no teto do saque. */
  waiting_funds_amount?: number;
  transferred_amount?: number;
}

/** Centavos → "R$ 1.234,56", para mensagens que o vendedor lê. */
function brl(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** O que a tela de saque precisa saber antes de deixar o vendedor digitar. */
export interface WithdrawalLimits {
  balanceInCents: number;
  pendingInCents: number;
  feeInCents: number;
  minInCents: number;
  maxWithdrawableInCents: number;
  canWithdraw: boolean;
  /** `pagarme` quando o teto veio do saldo real por ser MENOR que a carteira. */
  limitSource: 'wallet' | 'pagarme';
}

/**
 * Saque do vendedor: move o saldo DISPONÍVEL da wallet (espelho do recebedor
 * Pagar.me) para a conta bancária cadastrada, via `POST /transfers`.
 *
 * Substitui o fluxo Stripe Connect (`transfers.create` + `stripeAccountId`).
 * O transfer da Pagar.me é ASSÍNCRONO: o saque nasce `processing` e só vira
 * `paid`/`failed` pelo webhook `transfer.*` (`pagarme.transfer.updated`).
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly pagarme: PagarmeService,
    private readonly walletService: WalletService,
  ) {}

  // ── Listar saques do seller autenticado ──────────────────────────────────

  async findMyWithdrawals(userId: string) {
    return this.db
      .select()
      .from(schema.withdrawalRequests)
      .where(eq(schema.withdrawalRequests.userId, userId));
  }

  // ── Saldo real do recebedor na Pagar.me ──────────────────────────────────

  /**
   * Disponível de fato no recebedor, ou `null` se não deu para saber.
   *
   * Degrada em vez de bloquear: saque indisponível porque a consulta de saldo
   * caiu seria trocar um problema raro por um diário. Quando volta `null`,
   * quem chama usa só a carteira.
   */
  private async fetchRecipientAvailableCents(
    recipientId: string,
  ): Promise<number | null> {
    try {
      const balance = await this.pagarme.get<PagarmeRecipientBalance>(
        `/recipients/${recipientId}/balance`,
        undefined,
        BALANCE_TIMEOUT_MS,
      );
      const disponivel = balance?.available_amount;
      return typeof disponivel === 'number' && Number.isFinite(disponivel)
        ? disponivel
        : null;
    } catch (err: any) {
      this.logger.warn(
        `Saldo do recebedor ${recipientId} indisponível — seguindo só pela carteira. ${motivoPagarme(err) ?? err?.message ?? ''}`,
      );
      return null;
    }
  }

  // ── Limites do saque ─────────────────────────────────────────────────────

  /**
   * Tudo que a tela precisa para exibir um número que FUNCIONA.
   *
   * Antes disso o front usava `balanceInCents` como teto e anunciava
   * "Máximo {saldo}" — justamente o valor que a Pagar.me recusa, porque a taxa
   * sai por cima. Backend passa a ser a única fonte do mínimo, da taxa e do
   * máximo.
   */
  async getLimits(userId: string): Promise<WithdrawalLimits> {
    const wallet = await this.walletService.getOrCreateWallet(userId);

    const [sellerProfile] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    const recipientId = sellerProfile?.pagarmeRecipientId ?? null;
    const canWithdraw = Boolean(recipientId && sellerProfile?.canWithdraw);

    const recipientAvailable = recipientId
      ? await this.fetchRecipientAvailableCents(recipientId)
      : null;

    // Divergência entre carteira e recebedor é sintoma de lançamento faltando
    // no ledger — foi assim que a taxa de saque passou meses invisível.
    if (
      recipientAvailable !== null &&
      recipientAvailable !== wallet.balanceInCents + wallet.pendingInCents
    ) {
      this.logger.warn(
        `⚠️ Divergência de saldo — seller ${userId}: carteira ${wallet.balanceInCents} + retido ${wallet.pendingInCents} ≠ Pagar.me ${recipientAvailable}.`,
      );
    }

    return {
      balanceInCents: wallet.balanceInCents,
      pendingInCents: wallet.pendingInCents,
      feeInCents: WITHDRAWAL_FEE_CENTS,
      minInCents: WITHDRAWAL_MIN_CENTS,
      maxWithdrawableInCents: calcMaxWithdrawableInCents(
        wallet.balanceInCents,
        recipientAvailable,
      ),
      canWithdraw,
      limitSource:
        recipientAvailable !== null &&
        recipientAvailable < wallet.balanceInCents
          ? 'pagarme'
          : 'wallet',
    };
  }

  // ── Solicitar saque ──────────────────────────────────────────────────────

  async requestWithdrawal(userId: string, dto: RequestWithdrawalDto) {
    const { amountInCents } = dto;

    // O vendedor pede o LÍQUIDO (o que cai no banco); a taxa vem por cima.
    const feeInCents = WITHDRAWAL_FEE_CENTS;
    const totalInCents = amountInCents + feeInCents;

    // Regra 1: valor mínimo
    if (amountInCents < WITHDRAWAL_MIN_CENTS) {
      throw new BadRequestException(
        `O valor mínimo para saque é R$${WITHDRAWAL_MIN_CENTS / 100},00`,
      );
    }

    // Regra 2 + gate (5.2): recebedor Pagar.me apto a sacar
    const [sellerProfile] = await this.db
      .select()
      .from(schema.sellerProfiles)
      .where(eq(schema.sellerProfiles.userId, userId));

    if (!sellerProfile?.pagarmeRecipientId) {
      throw new BadRequestException(
        'Recebedor Pagar.me não configurado. Conclua o cadastro de recebimentos primeiro.',
      );
    }
    if (!sellerProfile.canWithdraw) {
      throw new BadRequestException(
        'Sua conta ainda não está habilitada para saques. Conclua a verificação (prova de vida).',
      );
    }

    // Regra 3: saldo da carteira cobre valor + taxa.
    // A mensagem diz o número que falta: "saldo insuficiente" sozinho é o que
    // fazia o vendedor tentar valores no chute até desistir.
    const wallet = await this.walletService.getOrCreateWallet(userId);
    if (wallet.balanceInCents < totalInCents) {
      throw new BadRequestException(
        `Saldo insuficiente. Este saque debita ${brl(totalInCents)} (${brl(amountInCents)} + ${brl(feeInCents)} de taxa) e você tem ${brl(wallet.balanceInCents)} disponível.`,
      );
    }

    // Regra 4: o saldo REAL do recebedor também cobre. Sem isto o saque nasce
    // condenado — debita, chama a Pagar.me, toma recusa e estorna, e o vendedor
    // só vê o saldo sumir e voltar.
    const recipientAvailable = await this.fetchRecipientAvailableCents(
      sellerProfile.pagarmeRecipientId,
    );
    if (recipientAvailable !== null && recipientAvailable < totalInCents) {
      this.logger.warn(
        `Saque barrado antes do débito — seller ${userId}: pediu ${totalInCents}, recebedor tem ${recipientAvailable}.`,
      );
      throw new BadRequestException(
        `Saldo insuficiente na conta de pagamentos. O máximo que você consegue sacar agora é ${brl(Math.max(0, recipientAvailable - feeInCents))}.`,
      );
    }

    // Debita valor + taxa imediatamente (fica "em trânsito"); reversão em falha.
    await this.walletService.debit(
      wallet.id,
      totalInCents,
      `Saque para conta bancária (Pagar.me) — ${brl(amountInCents)} + ${brl(feeInCents)} de taxa`,
    );

    // Registra o saque como PROCESSING antes de chamar o gateway (idempotência
    // estável por linha + rastreabilidade caso o POST caia).
    const [withdrawal] = await this.db
      .insert(schema.withdrawalRequests)
      .values({
        userId,
        amountInCents,
        feeInCents,
        status: 'processing',
        pagarmeRecipientId: sellerProfile.pagarmeRecipientId,
      })
      .returning();

    try {
      // NOTA (ponta P-transfer) — sondado na conta nova em 31/07, revisado em
      // 07/08 com a resposta do suporte e a documentação. Os DOIS endpoints
      // existem e se comportam diferente:
      //
      //   `POST /transfers`                    → 401 "IP de origem não
      //     autorizado a realizar essa operação". É a ROTA CERTA: a doc pública
      //     a lista como atual (docs.pagar.me/reference/criando-uma-transferência).
      //     O filtro de IP do DASHBOARD foi descartado por eliminação em 01/08 —
      //     o campo "IPs permitidos" foi esvaziado e o 401 permaneceu, do Shell
      //     da Render, com a `sk_live`, que era o cenário em que um filtro
      //     configurável teria que passar. Reproduz também com `sk_test` da
      //     máquina local, no mesmo segundo em que `POST /recipients` dá 200.
      //     A conta ANTIGA tem o mesmo campo vazio e sempre funcionou.
      //     Em 07/08 o suporte informou que NENHUM pedido de saque chega por
      //     API do nosso lado ⇒ a recusa acontece ANTES da aplicação deles,
      //     em camada de borda (WAF/gateway), que é por rota e não olha o
      //     campo do painel. Mesma causa do `kyc_link` (ver recipients.service)
      //     e mesmo tipo de liberação que marketplace/split exigiu do suporte.
      //     ⇒ Enquanto não for liberado, TODO saque falha aqui. O estorno
      //     abaixo devolve o saldo, então não há perda — mas ninguém saca.
      //
      //   `POST /recipients/{id}/withdrawals`  → não é recusado e criou um
      //     `with_...` de verdade (que nasceu `failed` por falta de saldo
      //     disponível — o dinheiro do cartão fica em `waiting_funds`).
      //     ⚠️ NÃO migrar para cá: a doc marca essa rota como DEPRECIADA,
      //     apontando justamente para Transferências. O nome engana.
      //
      // Mantido em `/transfers` por confirmação documental. Ver
      // docs/PLAN-pagarme-conta-nova.md (bloqueio 6) e
      // docs/CHAMADO-pagarme-transfers-401.md.
      const transfer = await this.pagarme.post<PagarmeTransfer>(
        '/transfers',
        {
          amount: amountInCents,
          recipient_id: sellerProfile.pagarmeRecipientId,
          metadata: { userId, withdrawalId: withdrawal.id },
        },
        `withdrawal-${withdrawal.id}`, // Idempotency-Key
      );

      await this.db
        .update(schema.withdrawalRequests)
        .set({ pagarmeTransferId: transfer.id, updatedAt: new Date() })
        .where(eq(schema.withdrawalRequests.id, withdrawal.id));

      this.logger.log(
        `💸 Saque ${withdrawal.id} criado (transfer ${transfer.id}, status ${transfer.status ?? 'processing'}) — seller ${userId}`,
      );

      return { ...withdrawal, pagarmeTransferId: transfer.id };
    } catch (err: any) {
      // Falha ao criar o transfer → estorna o débito (valor + taxa) e marca o
      // saque como failed.
      await this.walletService.credit(
        wallet.id,
        totalInCents,
        `Estorno — falha ao criar saque #${withdrawal.id.slice(0, 8)}`,
      );

      // Grava o motivo REAL. Até 13/08 isto era a string fixa "Falha ao criar
      // transfer na Pagar.me", então o motivo verdadeiro não existia em lugar
      // nenhum do banco: descobrir por que três saques falharam exigiu o
      // extrato da Pagar.me na mão do dono. Diagnóstico tem que ser leitura
      // de banco.
      const motivo = motivoPagarme(err);
      await this.db
        .update(schema.withdrawalRequests)
        .set({
          status: 'failed',
          failureReason: motivo
            ? `Pagar.me: ${motivo}`.slice(0, 500)
            : `Falha ao criar transfer na Pagar.me${err?.message ? ` (${String(err.message).slice(0, 200)})` : ''}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.withdrawalRequests.id, withdrawal.id));

      this.logger.error(
        `❌ Saque ${withdrawal.id} falhou na criação do transfer. Estornado ${totalInCents}. ${motivo ?? err?.message ?? ''}`,
      );
      throw new BadGatewayException(
        'Não foi possível processar o saque agora. O saldo foi mantido.',
      );
    }
  }

  // ── Webhook: transfer.* → conclui ou reverte o saque ──────────────────────

  /**
   * Emitido pelo webhook unificado para qualquer `transfer.*`. O `data` é o
   * objeto transfer da Pagar.me; o `status` define o desfecho. Idempotente.
   */
  @OnEvent('pagarme.transfer.updated')
  async handleTransferUpdated(data: any) {
    const transferId = data?.id;
    const status = data?.status;
    if (!transferId) {
      this.logger.warn('transfer.* sem id no payload — ignorado.');
      return;
    }

    const [withdrawal] = await this.db
      .select()
      .from(schema.withdrawalRequests)
      .where(eq(schema.withdrawalRequests.pagarmeTransferId, transferId));

    if (!withdrawal) {
      this.logger.warn(`Nenhum saque para pagarmeTransferId=${transferId}.`);
      return;
    }

    // Estado terminal já processado → idempotência.
    if (withdrawal.status === 'paid' || withdrawal.status === 'failed') {
      return;
    }

    if (status === 'paid') {
      await this.db
        .update(schema.withdrawalRequests)
        .set({ status: 'paid', updatedAt: new Date() })
        .where(eq(schema.withdrawalRequests.id, withdrawal.id));
      this.logger.log(`✅ Saque ${withdrawal.id} PAGO (transfer ${transferId}).`);
      return;
    }

    if (status === 'failed' || status === 'canceled') {
      // Reverte o saldo (o transfer não saiu). Devolve exatamente o que foi
      // debitado — valor + taxa —, senão a carteira volta a divergir do
      // recebedor, que é a origem de todo este módulo.
      //
      // ⚠️ EM ABERTO: não está confirmado se a Pagar.me devolve a taxa quando
      // um transfer JÁ CRIADO falha depois. Se ela retiver, este estorno
      // devolve R$ 3,67 a mais e o desvio nasce de novo, pelo outro lado. O
      // alerta de divergência em `getLimits` pega; a pergunta está em
      // `docs/PENDENCIA-pagarme-webhook-transferencia.md`.
      const wallet = await this.walletService.getOrCreateWallet(
        withdrawal.userId,
      );
      const estornoInCents =
        withdrawal.amountInCents + (withdrawal.feeInCents ?? 0);
      await this.walletService.credit(
        wallet.id,
        estornoInCents,
        `Estorno — saque não concluído #${withdrawal.id.slice(0, 8)}`,
      );
      await this.db
        .update(schema.withdrawalRequests)
        .set({
          status: 'failed',
          failureReason: data?.status_reason ?? `transfer ${status}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.withdrawalRequests.id, withdrawal.id));
      this.logger.error(
        `❌ Saque ${withdrawal.id} ${status}. Saldo estornado para ${withdrawal.userId}.`,
      );
      return;
    }

    // pending/processing/created → segue em 'processing' (sem ação).
    this.logger.log(
      `Saque ${withdrawal.id}: transfer ${transferId} em '${status}'.`,
    );
  }
}
