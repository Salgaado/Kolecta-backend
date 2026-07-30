import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, like, ne } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { MailService } from './mail/mail.service';
import { TemplateSlug } from './templates';

/**
 * Disparo de comunicado para toda a base.
 *
 * Difere de tudo que existe no NotificationsModule: os outros e-mails saem de
 * um evento de domínio, para UMA pessoa, como efeito de algo que ela fez. Este
 * sai por decisão humana, para centenas de pessoas de uma vez, e não tem como
 * ser desfeito depois que a primeira mensagem entrega.
 *
 * Por isso o padrão é o contrário do resto do módulo — aqui nada sai por
 * acidente:
 *
 *  - `dryRun` é TRUE por omissão. Só envia de verdade quem passar `dryRun:false`
 *    explicitamente. Chamada sem parâmetro nenhum lista destinatários e para.
 *  - `campanha` vira o refId de cada envio, então o MailService recusa a segunda
 *    tentativa para o mesmo destinatário. Rodar duas vezes não manda dois
 *    e-mails; retomar um disparo interrompido continua de onde parou.
 *  - `apenasPara` limita a um endereço, para conferir o visual antes da base.
 *  - Envio em série com pausa: a Resend limita a ~2 req/s e devolve 429 se
 *    passar. Rajada de 455 e-mails de uma vez seria metade recusada.
 */
@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
    private readonly mail: MailService,
  ) {}

  /**
   * Domínios de semente/teste que existem no banco mas não são caixas reais.
   * Ficam de fora do disparo: e-mail para endereço inexistente volta como hard
   * bounce, e uma leva de bounces logo no primeiro envio grande é o jeito mais
   * rápido de derrubar a reputação do domínio remetente na Resend.
   */
  private static readonly DOMINIOS_FALSOS =
    /@(email|example|test)\.com$|@localhost/i;

  /** Destinatários: toda conta com e-mail real. */
  async destinatarios(): Promise<Array<{ email: string; name: string | null }>> {
    const linhas = await this.db
      .select({ email: schema.users.email, name: schema.users.name })
      .from(schema.users)
      .where(
        and(
          isNotNull(schema.users.email),
          ne(schema.users.email, ''),
          like(schema.users.email, '%@%'),
        ),
      );

    return linhas.filter(
      (l) => !BroadcastService.DOMINIOS_FALSOS.test(l.email),
    );
  }

  /**
   * Destinatários que já receberam esta campanha com sucesso.
   * Fail-open: se a consulta falhar, devolve vazio e o MailService ainda barra
   * o reenvio individualmente — mais lento, porém nunca duplicado.
   */
  private async jaEnviados(
    template: string,
    campanha: string,
  ): Promise<Set<string>> {
    try {
      const linhas = await this.db
        .select({ recipient: schema.emailLog.recipient })
        .from(schema.emailLog)
        .where(
          and(
            eq(schema.emailLog.template, template),
            eq(schema.emailLog.refId, campanha),
            eq(schema.emailLog.status, 'sent'),
          ),
        );
      return new Set(linhas.map((l) => l.recipient.toLowerCase()));
    } catch (err) {
      this.logger.warn(
        `Não consegui ler email_log da campanha ${campanha}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return new Set();
    }
  }

  async enviar(opts: {
    template: TemplateSlug;
    campanha: string;
    dryRun?: boolean;
    apenasPara?: string;
    limite?: number;
    pausaMs?: number;
  }): Promise<{
    dryRun: boolean;
    campanha: string;
    total: number;
    enviados: number;
    amostra: string[];
  }> {
    // Omitir `dryRun` significa ensaio. A ausência de informação nunca dispara.
    const dryRun = opts.dryRun !== false;
    const pausaMs = opts.pausaMs ?? 600;

    let alvos = opts.apenasPara
      ? [{ email: opts.apenasPara, name: null as string | null }]
      : await this.destinatarios();

    // Tira quem já recebeu esta campanha. O MailService também recusaria o
    // reenvio, mas tarde demais: a pausa entre iterações aconteceria mesmo
    // assim, e 453 destinatários a 600ms seguram a requisição por 4,5 minutos
    // — muito além do que um proxy de produção tolera. Excluindo antes, o
    // disparo vira retomável: chame com `limite:100` quantas vezes precisar,
    // que cada rodada pega só quem ainda falta.
    const jaEnviados = await this.jaEnviados(opts.template, opts.campanha);
    if (jaEnviados.size > 0) {
      const antes = alvos.length;
      alvos = alvos.filter((a) => !jaEnviados.has(a.email.toLowerCase()));
      this.logger.log(
        `Campanha ${opts.campanha}: ${antes - alvos.length} já receberam, ${alvos.length} restantes.`,
      );
    }

    if (opts.limite && opts.limite > 0) {
      alvos = alvos.slice(0, opts.limite);
    }

    const amostra = alvos.slice(0, 5).map((a) => a.email);

    if (dryRun) {
      this.logger.log(
        `[ENSAIO] "${opts.template}" atingiria ${alvos.length} destinatário(s). ` +
          'Nenhum e-mail foi enviado. Para enviar de verdade: dryRun=false.',
      );
      return {
        dryRun: true,
        campanha: opts.campanha,
        total: alvos.length,
        enviados: 0,
        amostra,
      };
    }

    this.logger.warn(
      `⚠️  DISPARO REAL "${opts.template}" para ${alvos.length} destinatário(s) — campanha ${opts.campanha}.`,
    );

    let enviados = 0;
    for (const alvo of alvos) {
      // O MailService não lança: falha de um destinatário não interrompe a fila.
      await this.mail.send({
        to: alvo.email,
        template: opts.template,
        data: { name: alvo.name },
        // refId = campanha → o mesmo par (campanha, e-mail) nunca sai duas vezes.
        refId: opts.campanha,
      });
      enviados++;

      if (enviados % 50 === 0) {
        this.logger.log(`… ${enviados}/${alvos.length}`);
      }
      if (pausaMs > 0) {
        await new Promise((r) => setTimeout(r, pausaMs));
      }
    }

    this.logger.log(`✅ Disparo concluído: ${enviados}/${alvos.length}.`);
    return {
      dryRun: false,
      campanha: opts.campanha,
      total: alvos.length,
      enviados,
      amostra,
    };
  }
}
