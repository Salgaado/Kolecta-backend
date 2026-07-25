import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Req,
  Res,
  Param,
  ForbiddenException,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { ShippingService } from './shipping.service';
import { QuoteShippingDto, GenerateLabelDto } from './dto/shipping.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('api/shipping')
export class ShippingController {
  constructor(
    private readonly shippingService: ShippingService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  // Cotação é aberta (só estima preço; usada no checkout sem token).
  @Post('quote')
  async quote(@Body() dto: QuoteShippingDto) {
    return this.shippingService.quoteShipping(dto);
  }

  // Etiqueta é uma ação: exige auth e que o vendedor seja o dono do pedido.
  @Post('label')
  @UseGuards(AuthGuard)
  async generateLabel(@Req() req: any, @Body() dto: GenerateLabelDto) {
    return this.shippingService.generateLabel(dto, req.auth.userId);
  }

  /**
   * Reemite a etiqueta de um pedido.
   *
   * A emissão normal é automática (no pagamento/arremate). Este endpoint existe
   * para o caso em que ela falhou — tipicamente saldo insuficiente na carteira
   * do Melhor Envio: depois de recarregar, o vendedor tenta de novo daqui sem
   * precisar de ninguém.
   *
   * A emissão é idempotente por `shippingCartId`, então repetir não cria outro
   * carrinho nem gasta de novo.
   */
  @Post('label/:orderId/retry')
  @UseGuards(AuthGuard)
  async retryLabel(@Req() req: any, @Param('orderId') orderId: string) {
    await this.exigirDonoOuAdmin(req.auth.userId, orderId);
    return this.shippingService.emitirEtiquetaDoPedido(orderId);
  }

  /**
   * Entrega o PDF da etiqueta pela NOSSA autenticação.
   *
   * Antes o botão apontava para a URL do `print` do Melhor Envio — que é página
   * de painel: o vendedor caía na tela de login de uma conta que não é dele, e
   * mesmo com conta própria não acharia o envio, porque ele pertence à conta da
   * Kolecta. Agora o arquivo passa por aqui e ele nunca precisa saber que
   * existe um Melhor Envio no meio.
   */
  @Get('label/:orderId/pdf')
  @UseGuards(AuthGuard)
  async baixarEtiqueta(
    @Req() req: any,
    @Param('orderId') orderId: string,
    @Res() res: Response,
  ) {
    await this.exigirDonoOuAdmin(req.auth.userId, orderId);
    const { arquivo, nome } =
      await this.shippingService.obterPdfDaEtiqueta(orderId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.setHeader('Content-Length', String(arquivo.length));
    res.end(arquivo);
  }

  /** Só o vendedor dono do pedido (ou um admin) mexe na etiqueta dele. */
  private async exigirDonoOuAdmin(userId: string, orderId: string) {
    const order = await this.db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });
    if (!order) throw new NotFoundException(`Pedido ${orderId} não encontrado.`);

    const [user] = await this.db
      .select({ role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    if (order.sellerId !== userId && user?.role !== 'admin') {
      throw new ForbiddenException(
        'Você não tem permissão para acessar a etiqueta deste pedido.',
      );
    }
    return order;
  }
}
