import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BlingService } from './bling.service';

export interface OrderPaidEvent {
  orderId: string;
  sellerId: string;
  buyerId: string;
  buyerName: string | null;
  buyerEmail: string;
  listingTitle: string;
  totalInCents: number;
}

@Injectable()
export class BlingSyncService {
  private readonly logger = new Logger(BlingSyncService.name);

  constructor(private readonly blingService: BlingService) {}

  @OnEvent('order.paid')
  async handleOrderPaid(event: OrderPaidEvent) {
    this.logger.log(`Sincronizando pedido ${event.orderId} com Bling do seller ${event.sellerId}`);

    // Verifica se seller tem Bling conectado
    const status = await this.blingService.getStatus(event.sellerId);
    if (!status.connected) {
      this.logger.debug(`Seller ${event.sellerId} não tem Bling conectado. Pulando.`);
      return;
    }

    try {
      const accessToken = await this.blingService.getValidToken(event.sellerId);

      const contatoId = await this.blingService.findOrCreateContact(accessToken, {
        name: event.buyerName,
        email: event.buyerEmail,
      });

      const blingOrderId = await this.blingService.createPedidoVenda({
        accessToken,
        contato: { id: contatoId },
        listingTitle: event.listingTitle,
        totalInCents: event.totalInCents,
        kolectaOrderId: event.orderId,
      });

      this.logger.log(
        `✅ Pedido Kolecta ${event.orderId} criado no Bling como #${blingOrderId} (seller ${event.sellerId})`,
      );
    } catch (err: any) {
      this.logger.error(
        `❌ Falha ao sincronizar pedido ${event.orderId} com Bling: ${err.message}`,
      );
    }
  }
}
