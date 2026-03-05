import { Controller, Post, Headers, Req, Res, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Webhook } from 'svix';
import { Inject } from '@nestjs/common';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';

@Controller('api/webhooks/clerk')
export class WebhookController {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  @Post()
  async handleWebhook(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('svix-id') svixId: string,
    @Headers('svix-timestamp') svixTimestamp: string,
    @Headers('svix-signature') svixSignature: string,
  ) {
    if (!svixId || !svixTimestamp || !svixSignature) {
      return res.status(HttpStatus.BAD_REQUEST).json({ message: 'Error occured -- no svix headers' });
    }

    const payload = req.body;
    const body = JSON.stringify(payload);
    const whSecret = process.env.CLERK_WEBHOOK_SECRET;

    if (!whSecret) {
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: 'Missing Webhook Secret' });
    }

    const wh = new Webhook(whSecret);
    let evt: any;

    try {
      evt = wh.verify(body, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      });
    } catch (err) {
      console.error('Error verifying webhook:', err.message);
      return res.status(HttpStatus.BAD_REQUEST).json({ message: 'Error occured' });
    }

    // Processar Evento user.created
    if (evt.type === 'user.created') {
      const { id, email_addresses, first_name, last_name } = evt.data;
      const email = email_addresses[0]?.email_address;
      const name = `${first_name ?? ''} ${last_name ?? ''}`.trim();

      console.log(`[Clerk Webhook] Novo Usuário Recebido -> ID: ${id}, Email: ${email}`);
      
      try {
        await this.db.insert(schema.users).values({
          id: id,
          email: email,
          name: name,
        });
        console.log(`[Drizzle] Usuário inserido no Turso com sucesso!`);
      } catch (insertError) {
        console.error(`[Drizzle] Erro ao inserir no Turso:`, insertError.message);
      }
    }

    return res.status(HttpStatus.OK).json({ success: true });
  }
}
