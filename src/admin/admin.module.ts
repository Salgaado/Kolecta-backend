import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ListingsModule } from '../listings/listings.module';
import { FounderModule } from '../founder/founder.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    ListingsModule,
    FounderModule,
    // Exporta MailService — usado pelo POST /api/admin/test-email.
    NotificationsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
