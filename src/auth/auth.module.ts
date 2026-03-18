import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  providers: [AuthGuard, RolesGuard],
  exports: [AuthGuard, RolesGuard, UsersModule],
})
export class AuthModule {}

