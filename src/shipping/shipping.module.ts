import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';
import { ShippingLabelListener } from './shipping-label.listener';
import { RastreioCron } from './rastreio.cron';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule entra pelo MailService: a última etapa da emissão da
  // etiqueta é mandar o PDF ao remetente.
  imports: [HttpModule, NotificationsModule],
  controllers: [ShippingController],
  providers: [ShippingService, ShippingLabelListener, RastreioCron],
  exports: [ShippingService],
})
export class ShippingModule {}
