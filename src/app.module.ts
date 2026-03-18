import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { WebhookModule } from './webhook/webhook.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ListingsModule } from './listings/listings.module';

@Module({
  imports: [DatabaseModule, WebhookModule, AuthModule, UsersModule, ListingsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

