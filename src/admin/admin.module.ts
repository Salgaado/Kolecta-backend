import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ListingsModule } from '../listings/listings.module';
import { FounderModule } from '../founder/founder.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PagarmeModule } from '../pagarme/pagarme.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    ListingsModule,
    FounderModule,
    // Exporta MailService — usado pelo POST /api/admin/test-email.
    NotificationsModule,
    // Exporta ConciliacaoService — POST /api/admin/orders/:id/conciliar.
    PagarmeModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
