import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ListingsModule } from '../listings/listings.module';

@Module({
  imports: [DatabaseModule, AuthModule, ListingsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
