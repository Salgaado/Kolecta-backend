import { Inject, Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { and, eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../../database/database.module';
import * as schema from '../../database/schema';
import { TEMPLATES, TemplateSlug, EmailTemplate } from '../templates';

/** Extrai mensagem de erro de forma type-safe (catch é `unknown`). */
function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SendOptions {
  to: string;
  template: TemplateSlug;
  data: Record<string, any>;
  /**
   * ID do recurso de origem (ex: orderId). Usado para idempotência: o mesmo
   * (template + refId + to) não é reenviado. Recomendado sempre informar.
   */
  refId?: string;
}

/**
 * Wrapper fino sobre o Resend. Responsabilidades:
 *  - renderizar template (subject + html);
 *  - idempotência via tabela email_log;
 *  - envio resiliente (nunca lança — e-mail é efeito colateral, não pode
 *    derrubar o fluxo de negócio que o disparou);
 *  - respeitar MAIL_ENABLED (desligável em dev/testes).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;
  private readonly replyTo: string;
  private readonly enabled: boolean;

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {
    const apiKey = process.env.RESEND_API_KEY;
    // Aceita os dois vocabulários: MAIL_* (usado no código desde sempre) e
    // EMAIL_* (nomes do kit/documentação). Evita a pegadinha silenciosa de
    // configurar no Render com o nome do doc e o serviço ignorar.
    this.from =
      process.env.MAIL_FROM ||
      process.env.EMAIL_REMETENTE ||
      'Kolecta <notificacoes@kolecta.com.br>';
    this.replyTo =
      process.env.MAIL_REPLY_TO ||
      process.env.EMAIL_RESPOSTA ||
      'suporte@kolecta.com.br';
    // Liga só se explicitamente habilitado E com API key presente.
    this.enabled = process.env.MAIL_ENABLED === 'true' && !!apiKey;
    this.resend = apiKey ? new Resend(apiKey) : null;

    if (!this.enabled) {
      // Diz exatamente o que falta — "desabilitado" sem motivo custou tempo.
      const faltando = [
        process.env.MAIL_ENABLED === 'true' ? null : 'MAIL_ENABLED=true',
        apiKey ? null : 'RESEND_API_KEY',
      ].filter(Boolean);
      this.logger.warn(
        `MailService DESABILITADO — faltando: ${faltando.join(' e ')}. ` +
          'Nenhum e-mail sai; os envios ficam registrados como "skipped" em email_log.',
      );
    } else {
      this.logger.log(`MailService ATIVO — remetente: ${this.from}`);
    }
  }

  async send({ to, template, data, refId }: SendOptions): Promise<void> {
    if (!to) {
      this.logger.warn(`E-mail "${template}" sem destinatário — ignorado.`);
      return;
    }

    const tpl: EmailTemplate = TEMPLATES[template];
    if (!tpl) {
      this.logger.error(`Template "${template}" não encontrado.`);
      return;
    }

    // ── Idempotência: já enviamos esse (template + refId + to)? ──────────────
    // Fail-open: se a tabela email_log ainda não existir no banco, apenas
    // segue (não bloqueia o envio).
    if (refId && (await this.alreadySent(template, refId, to))) {
      this.logger.debug(
        `E-mail "${template}" para ${to} (ref ${refId}) já enviado — pulando.`,
      );
      return;
    }

    const subject = tpl.subject(data);
    const htmlBody = tpl.html(data);
    const textBody = tpl.text(data);

    // ── Desabilitado: loga e registra como "skipped" (útil em dev) ───────────
    if (!this.enabled || !this.resend) {
      this.logger.log(
        `[MAIL OFF] "${template}" → ${to} · assunto: "${subject}"`,
      );
      await this.record({ template, to, refId, status: 'skipped' });
      return;
    }

    // ── Envio ────────────────────────────────────────────────────────────────
    try {
      const { data: res, error } = await this.resend.emails.send({
        from: this.from,
        to,
        replyTo: this.replyTo,
        subject,
        html: htmlBody,
        // Multipart (HTML + texto): melhora entregabilidade e acessibilidade.
        text: textBody,
      });

      if (error) {
        throw new Error(error.message || JSON.stringify(error));
      }

      this.logger.log(`✉️  "${template}" enviado para ${to} (id: ${res?.id})`);
      await this.record({
        template,
        to,
        refId,
        status: 'sent',
        providerId: res?.id,
      });
    } catch (err) {
      this.logger.error(
        `❌ Falha ao enviar "${template}" para ${to}: ${msg(err)}`,
      );
      await this.record({
        template,
        to,
        refId,
        status: 'failed',
        error: msg(err),
      });
      // Não relança: e-mail não pode quebrar o fluxo de negócio.
    }
  }

  /** Idempotência fail-open: true se já houve envio bem-sucedido igual. */
  private async alreadySent(
    template: string,
    refId: string,
    to: string,
  ): Promise<boolean> {
    try {
      const [existing] = await this.db
        .select({ id: schema.emailLog.id })
        .from(schema.emailLog)
        .where(
          and(
            eq(schema.emailLog.template, template),
            eq(schema.emailLog.refId, refId),
            eq(schema.emailLog.recipient, to),
            eq(schema.emailLog.status, 'sent'),
          ),
        )
        .limit(1);
      return !!existing;
    } catch (err) {
      this.logger.debug(
        `Checagem de idempotência falhou (${template}): ${msg(err)}`,
      );
      return false;
    }
  }

  private async record(opts: {
    template: string;
    to: string;
    refId?: string;
    status: 'sent' | 'failed' | 'skipped';
    providerId?: string;
    error?: string;
  }): Promise<void> {
    try {
      await this.db.insert(schema.emailLog).values({
        template: opts.template,
        recipient: opts.to,
        refId: opts.refId ?? null,
        status: opts.status,
        providerId: opts.providerId ?? null,
        error: opts.error ?? null,
      });
    } catch (err) {
      // O índice único pode estourar em corrida — não é erro fatal.
      this.logger.debug(
        `email_log insert falhou (${opts.template}): ${msg(err)}`,
      );
    }
  }
}
