import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { normalizarProduto } from './bling-catalogo';

type Database = any;

const BLING_AUTH_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
/**
 * Host dos DADOS. Diferente do host do OAuth acima, e não é detalhe.
 *
 * Era `www.bling.com.br/Api/v3` e o Bling respondia 403 em toda chamada:
 *
 *   "Tokens JWT só são permitidos quando a requisição passa pelo host
 *    api.bling.com.br. Acesso direto não é permitido."
 *
 * O engano é fácil porque o OAuth (autorizar e trocar o code por token) fica
 * mesmo em `www`, e funciona: duas lojas conectaram e apareceram como
 * "Autenticado" no Bling e "Conectado" na Kolecta. Só que NENHUMA chamada de
 * dado passava, então a integração parecia pronta e não fazia nada.
 *
 * Isso derrubava tudo que usa esta constante, e a sincronização de pedidos
 * (contato + pedido de venda) engole o erro em log de propósito, para não
 * derrubar uma venda já paga. Ou seja: ela também nunca funcionou, em silêncio,
 * desde que foi escrita.
 *
 * Verificado com o token real de uma loja conectada em 06/08/2026: `www` e
 * `bling.com.br` devolvem 403, `api.bling.com.br` devolve 200 com os produtos.
 */
const BLING_API_URL = 'https://api.bling.com.br/Api/v3';

@Injectable()
export class BlingService {
  private readonly logger = new Logger(BlingService.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  // ── OAuth: gerar URL de autorização ─────────────────────────────────────────

  getAuthUrl(userId: string): string {
    const clientId = process.env.BLING_CLIENT_ID;
    const redirectUri = process.env.BLING_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      throw new BadRequestException('Bling não configurado no servidor.');
    }

    // Endereço de volta apontando para a máquina de alguém é o erro mais fácil
    // de cometer aqui e o mais difícil de perceber: o lojista clica, é levado
    // ao Bling, autoriza, e o navegador DELE tenta voltar para um localhost que
    // não existe. Do lado da Kolecta não chega nada, nenhum log, nenhuma linha
    // no banco. O sintoma é "ninguém conectou", que é igualzinho a "ninguém
    // tentou".
    //
    // Falhar aqui, alto e cedo, é melhor: o lojista vê que a integração está
    // mal configurada em vez de sumir no meio do caminho.
    if (
      process.env.NODE_ENV === 'production' &&
      /localhost|127\.0\.0\.1|:\d{4,5}\/|^http:/i.test(redirectUri)
    ) {
      this.logger.error(
        `BLING_REDIRECT_URI inválido em produção: "${redirectUri}". ` +
          'Deve ser a URL pública HTTPS do backend e bater exatamente com o ' +
          'Link de redirecionamento cadastrado no app do Bling.',
      );
      throw new BadRequestException(
        'A integração com o Bling está mal configurada no servidor. ' +
          'Avise a equipe da Kolecta.',
      );
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state: this.assinarState(userId),
    });

    return `${BLING_AUTH_URL}?${params.toString()}`;
  }

  /**
   * `state` assinado, em vez do userId cru.
   *
   * O callback é público (o Bling redireciona o navegador para ele, sem token),
   * então o `state` é a ÚNICA coisa que diz de quem é a conexão. Com o userId
   * cru ali, bastava alguém montar a URL do callback com o `code` da própria
   * conta Bling e o userId de outra pessoa para amarrar o Bling dele à conta
   * dela. A partir daí, todo pedido daquele vendedor viraria pedido de venda no
   * Bling do atacante, com nome e e-mail dos compradores junto.
   *
   * A chave é o próprio BLING_CLIENT_SECRET: já é segredo de servidor e existe
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
   * inválida e state velho: o code do Bling é de uso único e curto, então uma
   * janela de 10 minutos é folgada para o usuário autorizar.
   */
  private lerState(state: string): string {
    const partes = String(state ?? '').split('.');
    if (partes.length !== 3) {
      throw new BadRequestException('Autorização do Bling inválida.');
    }
    const [userId, emitidoEm, assinatura] = partes;
    const esperada = this.hmac(`${userId}.${emitidoEm}`);

    // Comparação em tempo constante: comparar com === vaza, pelo tempo de
    // resposta, quantos bytes da assinatura o atacante já acertou.
    const a = Buffer.from(assinatura);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('Autorização do Bling inválida.');
    }
    if (Date.now() - Number(emitidoEm) > 10 * 60 * 1000) {
      throw new BadRequestException(
        'A autorização do Bling expirou. Tente conectar de novo.',
      );
    }
    return userId;
  }

  private hmac(corpo: string): string {
    const chave = process.env.BLING_CLIENT_SECRET;
    if (!chave) {
      throw new BadRequestException('Bling não configurado no servidor.');
    }
    return createHmac('sha256', chave).update(corpo).digest('hex');
  }

  // ── OAuth: trocar code por tokens ────────────────────────────────────────────

  /** `state` é o assinado por `getAuthUrl`, não um userId cru. Ver `lerState`. */
  async handleCallback(code: string, state: string): Promise<void> {
    const userId = this.lerState(state);
    const clientId = process.env.BLING_CLIENT_ID!;
    const clientSecret = process.env.BLING_CLIENT_SECRET!;
    const redirectUri = process.env.BLING_REDIRECT_URI!;

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await fetch(BLING_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      this.logger.error(`Bling token error: ${JSON.stringify(body)}`);
      throw new BadRequestException('Falha ao obter tokens do Bling.');
    }

    const data: any = await res.json();

    const expiresAt = Math.floor(Date.now() / 1000) + (data.expires_in ?? 21600);

    await this.db
      .insert(schema.blingConnections)
      .values({
        userId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: schema.blingConnections.userId,
        set: {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt,
          updatedAt: new Date(),
        },
      });

    this.logger.log(`Bling conectado para userId=${userId}`);
  }

  // ── Status da conexão ────────────────────────────────────────────────────────

  async getStatus(userId: string) {
    const [conn] = await this.db
      .select()
      .from(schema.blingConnections)
      .where(eq(schema.blingConnections.userId, userId));

    if (!conn) return { connected: false };

    const expired = Math.floor(Date.now() / 1000) >= conn.expiresAt;
    return { connected: true, expired };
  }

  // ── Desconectar ──────────────────────────────────────────────────────────────

  async disconnect(userId: string): Promise<void> {
    await this.db
      .delete(schema.blingConnections)
      .where(eq(schema.blingConnections.userId, userId));
    this.logger.log(`Bling desconectado para userId=${userId}`);
  }

  // ── Obter access_token válido (refresh automático) ───────────────────────────

  async getValidToken(userId: string): Promise<string> {
    const [conn] = await this.db
      .select()
      .from(schema.blingConnections)
      .where(eq(schema.blingConnections.userId, userId));

    if (!conn) throw new NotFoundException('Bling não conectado para este seller.');

    const nowSeconds = Math.floor(Date.now() / 1000);
    const isExpired = nowSeconds >= conn.expiresAt - 60; // 60s de margem

    if (!isExpired) return conn.accessToken;

    return this.refreshToken(userId, conn.refreshToken);
  }

  private async refreshToken(userId: string, refreshToken: string): Promise<string> {
    const clientId = process.env.BLING_CLIENT_ID!;
    const clientSecret = process.env.BLING_CLIENT_SECRET!;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await fetch(BLING_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    });

    if (!res.ok) {
      this.logger.error(`Falha ao renovar token Bling para userId=${userId}`);
      // Remove a conexão inválida
      await this.disconnect(userId);
      throw new BadRequestException('Token Bling expirado. Reconecte sua conta.');
    }

    const data: any = await res.json();
    const expiresAt = Math.floor(Date.now() / 1000) + (data.expires_in ?? 21600);

    await this.db
      .update(schema.blingConnections)
      .set({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.blingConnections.userId, userId));

    this.logger.log(`Token Bling renovado para userId=${userId}`);
    return data.access_token;
  }

  // ── Catálogo do lojista ──────────────────────────────────────────────────────

  /**
   * Uma página do catálogo do Bling, já normalizada para a tela.
   *
   * Usa a listagem BARATA de propósito. Ela não traz peso, dimensões nem GTIN,
   * que só existem no detalhe: buscar detalhe de tudo aqui custaria uma
   * requisição por produto para preencher uma tela que o lojista talvez nem
   * role até o fim. O detalhe é buscado só do que ele escolher importar.
   */
  async listarProdutos(userId: string, pagina = 1) {
    const token = await this.getValidToken(userId);
    const limite = 100; // teto da API
    const url = `${BLING_API_URL}/produtos?pagina=${pagina}&limite=${limite}&criterio=2`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const corpo = await res.text();
      this.logger.error(`Bling /produtos ${res.status}: ${corpo.slice(0, 300)}`);
      throw new BadGatewayException(
        'Não foi possível ler o catálogo do seu Bling. Tente de novo em instantes.',
      );
    }

    const { data } = await res.json();
    const produtos = (Array.isArray(data) ? data : []).map(normalizarProduto);
    return {
      produtos,
      pagina,
      // A API não devolve total. Página cheia significa que provavelmente há
      // mais; página curta é a última. Mesmo critério do `getAllPaged` do front.
      temMais: produtos.length === limite,
    };
  }

  /** Detalhe de um produto: peso, dimensões, GTIN e as fotos extras. */
  async detalharProduto(userId: string, produtoId: number): Promise<any> {
    const token = await this.getValidToken(userId);
    const res = await fetch(`${BLING_API_URL}/produtos/${produtoId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new BadGatewayException(
        `O Bling não devolveu o produto ${produtoId} (HTTP ${res.status}).`,
      );
    }
    const { data } = await res.json();
    return data;
  }

  // ── Criar ou buscar contato no Bling ─────────────────────────────────────────

  async findOrCreateContact(
    accessToken: string,
    buyer: { name: string | null; email: string },
  ): Promise<number> {
    const name = buyer.name ?? buyer.email;

    // Tenta buscar por email
    const searchRes = await fetch(
      `${BLING_API_URL}/contatos?email=${encodeURIComponent(buyer.email)}&limite=1`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (searchRes.ok) {
      const { data } = await searchRes.json();
      if (data?.length > 0) return data[0].id;
    }

    // Cria novo contato
    const createRes = await fetch(`${BLING_API_URL}/contatos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ nome: name, email: buyer.email, tipo: 'F' }),
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      this.logger.error(`Erro ao criar contato Bling: ${JSON.stringify(err)}`);
      // Retorna 0 — pedido será criado sem contato em caso de falha
      return 0;
    }

    const { data } = await createRes.json();
    return data.id;
  }

  // ── Criar pedido de venda no Bling ───────────────────────────────────────────

  async createPedidoVenda(params: {
    accessToken: string;
    contato: { id: number };
    listingTitle: string;
    totalInCents: number;
    kolectaOrderId: string;
  }): Promise<string> {
    const payload = {
      numero: params.kolectaOrderId.slice(0, 8).toUpperCase(),
      data: new Date().toISOString().split('T')[0],
      contato: params.contato.id > 0 ? { id: params.contato.id } : undefined,
      observacoes: `Pedido Kolecta #${params.kolectaOrderId}`,
      itens: [
        {
          descricao: params.listingTitle,
          valor: params.totalInCents / 100,
          quantidade: 1,
        },
      ],
    };

    const res = await fetch(`${BLING_API_URL}/pedidos/vendas`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Bling pedido error: ${JSON.stringify(err)}`);
    }

    const { data } = await res.json();
    return String(data.id);
  }
}
