import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

type Database = any;

/**
 * Integração com o Tiny (Olist ERP) — o segundo ERP do vendedor.
 *
 * Espelha `BlingService` de propósito, inclusive nos comentários: cada decisão
 * estranha aqui é uma cicatriz que o Bling já pagou em produção, e repetir o
 * erro em outro ERP seria pagar duas vezes. Ver docs/PLAN-tiny-olist.md.
 *
 * ⚠️ Escrito ANTES de existir conta no Tiny (25/08/2026). Endereços e formato do
 * OAuth vieram do `.well-known/openid-configuration` do Keycloak deles e do
 * `swagger.json` da API v3 — não de uma chamada autenticada. O que depende de
 * ver o dado real está marcado com ⚠️ e é trabalho da Fase 0 do plano.
 */

/**
 * TRÊS hosts, e a diferença não é detalhe.
 *
 * No Bling, o OAuth mora em `www.bling.com.br` e os dados em
 * `api.bling.com.br`. Apontar os dados para o `www` devolvia 403 em TODA
 * chamada — "Tokens JWT só são permitidos quando a requisição passa pelo host
 * api.bling.com.br" — e o pior: o OAuth funcionava. Duas lojas apareceram como
 * "Conectado" na Kolecta e a integração não fazia absolutamente nada, em
 * silêncio, até 06/08/2026.
 *
 * No Tiny o mesmo desenho se repete com um host a mais:
 *
 *   accounts.tiny.com.br  -> Keycloak, autorizar e trocar/renovar token
 *   api.tiny.com.br       -> os DADOS
 *   erp.tiny.com.br       -> só a documentação (Swagger)
 *
 * `erp.tiny.com.br/public-api/v3/*` responde `{"mensagem":"O recurso solicitado
 * não foi encontrado"}` (conferido em 25/08/2026). É o erro fácil de cometer
 * porque é o endereço que aparece na documentação.
 */
const TINY_REALM =
  'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect';
const TINY_AUTH_URL = `${TINY_REALM}/auth`;
const TINY_TOKEN_URL = `${TINY_REALM}/token`;
const TINY_REVOKE_URL = `${TINY_REALM}/revoke`;
const TINY_API_URL = 'https://api.tiny.com.br/public-api/v3';

/**
 * `offline_access` junto de `openid`.
 *
 * Sem ele, o Keycloak amarra o refresh token à SESSÃO do usuário — que expira
 * por inatividade (o padrão do Keycloak é 30 minutos ociosos). Uma integração
 * que sincroniza estoque de meia em meia hora e cria pedido de venda quando a
 * compra é paga precisa continuar funcionando com o lojista dormindo, e é isso
 * que o token offline dá.
 *
 * `offline_access` está entre os scopes anunciados pelo realm deles. ⚠️ Falta
 * confirmar que o NOSSO cliente tem o scope liberado — é a pergunta 2 do
 * e-mail em docs/EMAIL-olist-parceiros.md. Se recusarem, o sintoma é o lojista
 * ter que reconectar toda hora.
 */
const TINY_SCOPE = 'openid offline_access';

@Injectable()
export class TinyService {
  private readonly logger = new Logger(TinyService.name);

  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  // ── OAuth: gerar URL de autorização ─────────────────────────────────────────

  getAuthUrl(userId: string): string {
    const clientId = process.env.TINY_CLIENT_ID;
    const redirectUri = process.env.TINY_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      throw new BadRequestException('Tiny não configurado no servidor.');
    }

    // Endereço de volta apontando para a máquina de alguém é o erro mais fácil
    // de cometer aqui e o mais difícil de perceber: o lojista clica, é levado
    // ao Tiny, autoriza, e o navegador DELE tenta voltar para um localhost que
    // não existe. Do lado da Kolecta não chega nada, nenhum log, nenhuma linha
    // no banco. O sintoma é "ninguém conectou", que é igualzinho a "ninguém
    // tentou".
    if (
      process.env.NODE_ENV === 'production' &&
      /localhost|127\.0\.0\.1|:\d{4,5}\/|^http:/i.test(redirectUri)
    ) {
      this.logger.error(
        `TINY_REDIRECT_URI inválido em produção: "${redirectUri}". ` +
          'Deve ser a URL pública HTTPS do backend e bater exatamente com a ' +
          'URL de redirecionamento cadastrada no aplicativo do Tiny.',
      );
      throw new BadRequestException(
        'A integração com o Tiny está mal configurada no servidor. ' +
          'Avise a equipe da Kolecta.',
      );
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: TINY_SCOPE,
      state: this.assinarState(userId),
    });

    return `${TINY_AUTH_URL}?${params.toString()}`;
  }

  /**
   * `state` assinado, em vez do userId cru.
   *
   * O callback é público (o Tiny redireciona o navegador para ele, sem token),
   * então o `state` é a ÚNICA coisa que diz de quem é a conexão. Com o userId
   * cru ali, bastava alguém montar a URL do callback com o `code` da própria
   * conta Tiny e o userId de outra pessoa para amarrar o ERP dele à conta dela.
   * A partir daí, todo pedido daquele vendedor viraria pedido de venda no ERP
   * do atacante, com nome e e-mail dos compradores junto.
   *
   * A chave é o próprio TINY_CLIENT_SECRET: já é segredo de servidor e existe
   * exatamente onde este código roda, então não inventa mais uma variável de
   * ambiente para alguém esquecer de configurar.
   */
  private assinarState(userId: string): string {
    const emitidoEm = Date.now();
    const corpo = `${userId}.${emitidoEm}`;
    return `${corpo}.${this.hmac(corpo)}`;
  }

  /**
   * Devolve o userId de um `state` que a gente mesmo assinou. Recusa assinatura
   * inválida e state velho: o code do OAuth é de uso único e curto, então uma
   * janela de 10 minutos é folgada para o usuário autorizar.
   */
  private lerState(state: string): string {
    const partes = String(state ?? '').split('.');
    if (partes.length !== 3) {
      throw new BadRequestException('Autorização do Tiny inválida.');
    }
    const [userId, emitidoEm, assinatura] = partes;
    const esperada = this.hmac(`${userId}.${emitidoEm}`);

    // Comparação em tempo constante: comparar com === vaza, pelo tempo de
    // resposta, quantos bytes da assinatura o atacante já acertou.
    const a = Buffer.from(assinatura);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('Autorização do Tiny inválida.');
    }
    if (Date.now() - Number(emitidoEm) > 10 * 60 * 1000) {
      throw new BadRequestException(
        'A autorização do Tiny expirou. Tente conectar de novo.',
      );
    }
    return userId;
  }

  private hmac(corpo: string): string {
    const chave = process.env.TINY_CLIENT_SECRET;
    if (!chave) {
      throw new BadRequestException('Tiny não configurado no servidor.');
    }
    return createHmac('sha256', chave).update(corpo).digest('hex');
  }

  // ── OAuth: trocar code por tokens ───────────────────────────────────────────

  /** `state` é o assinado por `getAuthUrl`, não um userId cru. Ver `lerState`. */
  async handleCallback(code: string, state: string): Promise<void> {
    const userId = this.lerState(state);

    const res = await fetch(TINY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.TINY_REDIRECT_URI!,
        ...this.credenciaisNoCorpo(),
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      this.logger.error(`Tiny token error: ${JSON.stringify(body)}`);
      throw new BadRequestException('Falha ao obter tokens do Tiny.');
    }

    const data: any = await res.json();

    await this.db
      .insert(schema.tinyConnections)
      .values({
        userId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: this.expiraEm(data.expires_in),
      })
      .onConflictDoUpdate({
        target: schema.tinyConnections.userId,
        set: {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: this.expiraEm(data.expires_in),
          updatedAt: new Date(),
        },
      });

    this.logger.log(`Tiny conectado para userId=${userId}`);
  }

  /**
   * Keycloak manda `expires_in` em todo token, então o padrão abaixo quase
   * nunca é usado. Ele é CURTO (5 minutos) de propósito: se um dia vier sem, o
   * erro que a gente quer é renovar cedo demais, não usar token morto e ver a
   * integração inteira responder 401 sem explicação.
   *
   * ⚠️ A validade real do access_token e do refresh_token do Tiny é medida na
   * Fase 0 — é a pergunta 2 do e-mail para a Olist.
   */
  private expiraEm(expiresIn: unknown): number {
    const segundos =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn)
        ? expiresIn
        : 300;
    return Math.floor(Date.now() / 1000) + segundos;
  }

  /**
   * Credenciais no CORPO (`client_secret_post`).
   *
   * O realm deles aceita `client_secret_basic` e `client_secret_post` (lidos do
   * `.well-known` em 25/08/2026). O Bling usa Basic; aqui vai no corpo porque é
   * o que o Keycloak documenta como padrão e o que erra menos com segredo que
   * contém caractere especial — em Basic ele passa por base64 de uma
   * concatenação, e um `:` no meio do segredo quebra a leitura do outro lado.
   */
  private credenciaisNoCorpo(): Record<string, string> {
    const clientId = process.env.TINY_CLIENT_ID;
    const clientSecret = process.env.TINY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new BadRequestException('Tiny não configurado no servidor.');
    }
    return { client_id: clientId, client_secret: clientSecret };
  }

  // ── Status da conexão ───────────────────────────────────────────────────────

  async getStatus(userId: string) {
    const [conn] = await this.db
      .select()
      .from(schema.tinyConnections)
      .where(eq(schema.tinyConnections.userId, userId));

    if (!conn) return { connected: false, anunciosVinculados: 0 };

    const expired = Math.floor(Date.now() / 1000) >= conn.expiresAt;

    // Quantos anúncios seguem o estoque deste Tiny. É o número que responde a
    // pergunta que o lojista faz olhando a tela: "conectado, tá, mas está
    // fazendo alguma coisa?". Zero conectado significa que ele ainda não
    // importou nada, que é bem diferente de integração quebrada.
    const vinculados = await this.db
      .select({ id: schema.listings.id })
      .from(schema.listings)
      .where(
        and(
          eq(schema.listings.sellerId, userId),
          isNotNull(schema.listings.tinyProductId),
        ),
      );

    return { connected: true, expired, anunciosVinculados: vinculados.length };
  }

  // ── Desconectar ─────────────────────────────────────────────────────────────

  /**
   * Apaga a conexão e AVISA o Tiny.
   *
   * O Bling não faz a segunda parte porque não tem endpoint para isso; o
   * Keycloak tem (`/revoke`), e usar é o certo: sem revogar, o refresh token
   * continua valendo do lado deles depois de o lojista clicar em
   * "Desconectar" — e um token que sobrevive à desconexão é exatamente o tipo
   * de coisa que ninguém descobre até dar errado.
   *
   * Melhor-esforço: se a revogação falhar, a conexão some daqui do mesmo jeito.
   * O que o lojista pediu foi desconectar, e falhar nisso por causa da API
   * deles seria transformar um clique dele em erro nosso.
   */
  async disconnect(userId: string): Promise<void> {
    const [conn] = await this.db
      .select()
      .from(schema.tinyConnections)
      .where(eq(schema.tinyConnections.userId, userId));

    if (conn?.refreshToken) {
      try {
        await fetch(TINY_REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: conn.refreshToken,
            token_type_hint: 'refresh_token',
            ...this.credenciaisNoCorpo(),
          }).toString(),
        });
      } catch (err: any) {
        this.logger.warn(
          `Revogação do token Tiny falhou (userId=${userId}): ${err?.message ?? err}. Desconectando mesmo assim.`,
        );
      }
    }

    await this.db
      .delete(schema.tinyConnections)
      .where(eq(schema.tinyConnections.userId, userId));
    this.logger.log(`Tiny desconectado para userId=${userId}`);
  }

  // ── Obter access_token válido (refresh automático) ──────────────────────────

  async getValidToken(userId: string): Promise<string> {
    const [conn] = await this.db
      .select()
      .from(schema.tinyConnections)
      .where(eq(schema.tinyConnections.userId, userId));

    if (!conn)
      throw new NotFoundException('Tiny não conectado para este seller.');

    const nowSeconds = Math.floor(Date.now() / 1000);
    const isExpired = nowSeconds >= conn.expiresAt - 60; // 60s de margem

    if (!isExpired) return conn.accessToken;

    return this.refreshToken(userId, conn.refreshToken);
  }

  private async refreshToken(
    userId: string,
    refreshToken: string,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(TINY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          ...this.credenciaisNoCorpo(),
        }).toString(),
      });
    } catch (err: any) {
      // Falha de REDE é transitória por definição. Desconectar aqui obrigaria o
      // lojista a reconectar por um soluço do Tiny que já passou. Mantém a
      // conexão e deixa o próximo ciclo tentar de novo.
      this.logger.warn(
        `Rede falhou ao renovar token Tiny (userId=${userId}): ${err?.message ?? err}. Conexão mantida.`,
      );
      throw new BadGatewayException(
        'Não foi possível falar com o Tiny agora. Sua conexão foi mantida, tente de novo em instantes.',
      );
    }

    if (!res.ok) {
      const corpo: any = await res.json().catch(() => ({}));
      const motivo = String(corpo?.error ?? corpo?.error_description ?? '');

      // SÓ desconecta quando o refresh token foi de fato revogado, expirado ou
      // já usado: o Keycloak responde 400 com `invalid_grant`. Aí reconectar é
      // o único caminho e insistir com o mesmo token nunca resolveria.
      const definitivo = res.status === 400 && /invalid_grant/i.test(motivo);

      if (!definitivo) {
        // 5xx, 429, invalid_client e afins: problema do lado do Tiny ou config
        // do servidor. Em nenhum deles desconectar o lojista ajuda: ou o
        // problema passa sozinho, ou quem precisa agir é a Kolecta.
        this.logger.error(
          `Falha transitória ao renovar token Tiny (userId=${userId}, HTTP ${res.status}, ${motivo}). Conexão mantida.`,
        );
        throw new BadGatewayException(
          'O Tiny não respondeu agora. Sua conexão foi mantida, tente de novo em instantes.',
        );
      }

      // Antes de desconectar, confere se OUTRO processo já renovou no meio do
      // caminho. Se o Keycloak estiver com rotação de refresh token ligada, o
      // token é de uso único: caso o cron tenha renovado entre a nossa leitura e
      // agora, o que usamos ficou velho e este `invalid_grant` é falso alarme.
      // Foi essa corrida que derrubou uma conexão real do Bling num teste.
      const [atual] = await this.db
        .select()
        .from(schema.tinyConnections)
        .where(eq(schema.tinyConnections.userId, userId));

      if (atual && atual.refreshToken !== refreshToken) {
        this.logger.log(
          `Refresh do Tiny já renovado por outro processo (userId=${userId}); usando o token atual.`,
        );
        const agora = Math.floor(Date.now() / 1000);
        if (agora < atual.expiresAt - 60) return atual.accessToken;
        // O token novo também já venceu: uma tentativa com ele. Se falhar de
        // novo com invalid_grant, a comparação acima não muda e a próxima
        // passada desconecta, sem laço infinito.
        return this.refreshToken(userId, atual.refreshToken);
      }

      this.logger.warn(
        `Refresh token do Tiny inválido (userId=${userId}, ${motivo}). Desconectando.`,
      );
      await this.db
        .delete(schema.tinyConnections)
        .where(eq(schema.tinyConnections.userId, userId));
      throw new BadRequestException(
        'Sua conexão com o Tiny expirou. Reconecte sua conta.',
      );
    }

    const data: any = await res.json();

    // O Keycloak só manda `refresh_token` novo quando a rotação está ligada.
    // Sobrescrever com `undefined` apagaria o token bom e desconectaria o
    // lojista na próxima renovação — o Bling sempre rotaciona e por isso não
    // precisou desta linha.
    const novoRefresh = data.refresh_token ?? refreshToken;

    await this.db
      .update(schema.tinyConnections)
      .set({
        accessToken: data.access_token,
        refreshToken: novoRefresh,
        expiresAt: this.expiraEm(data.expires_in),
        updatedAt: new Date(),
      })
      .where(eq(schema.tinyConnections.userId, userId));

    this.logger.log(`Token Tiny renovado para userId=${userId}`);
    return data.access_token;
  }

  // ── Prova de vida ───────────────────────────────────────────────────────────

  /**
   * `GET /info` — dados da conta do lojista no ERP.
   *
   * Existe por causa do 403 silencioso do Bling: "conectado" no nosso banco não
   * prova que uma chamada de DADO passa. Este endpoint é o mais barato da API e
   * não depende do formato de nada nosso, então serve para responder, em uma
   * chamada, se o token vale e se o host está certo.
   */
  async verificarConexao(userId: string): Promise<any> {
    const token = await this.getValidToken(userId);
    const res = await fetch(`${TINY_API_URL}/info`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    if (!res.ok) {
      const corpo = await res.text();
      this.logger.error(`Tiny /info ${res.status}: ${corpo.slice(0, 300)}`);
      throw new BadGatewayException(
        `O Tiny recusou a chamada de teste (HTTP ${res.status}).`,
      );
    }

    return res.json();
  }
}
