import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';
import { ShippingLabelListener } from './shipping-label.listener';
import { RastreioCron } from './rastreio.cron';
import { FreteSubsidioService } from './frete-subsidio.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule entra pelo MailService: a última etapa da emissão da
  // etiqueta é mandar o PDF ao remetente.
  imports: [HttpModule, NotificationsModule],
  controllers: [ShippingController],
  providers: [
    ShippingService,
    ShippingLabelListener,
    RastreioCron,
    FreteSubsidioService,
  ],
  // FreteSubsidioService sai daqui porque quem decide o frete são os dois
  // módulos que já importam este: OrdersModule (venda direta) e AuctionsModule
  // (leilão). Ver docs/PLAN-frete-compartilhado.md §2.
  exports: [ShippingService, FreteSubsidioService],
})
export class ShippingModule {}
