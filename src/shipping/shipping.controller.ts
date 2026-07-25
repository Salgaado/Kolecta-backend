import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Param,
  ForbiddenException,
  NotFoundException,
  Inject,
} from '@nestjs/common';
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
    const userId = req.auth.userId;

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
        'Você não tem permissão para emitir a etiqueta deste pedido.',
      );
    }

    return this.shippingService.emitirEtiquetaDoPedido(orderId);
  }
}
