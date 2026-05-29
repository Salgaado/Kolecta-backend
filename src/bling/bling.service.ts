import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

type Database = any;

const BLING_AUTH_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const BLING_API_URL = 'https://www.bling.com.br/Api/v3';

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

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state: userId,
    });

    return `${BLING_AUTH_URL}?${params.toString()}`;
  }

  // ── OAuth: trocar code por tokens ────────────────────────────────────────────

  async handleCallback(code: string, userId: string): Promise<void> {
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
