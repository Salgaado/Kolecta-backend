import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AuthModule } from '../auth/auth.module';

// DatabaseModule é @Global, então o DATABASE_CONNECTION já está disponível.
//
// AuthModule NÃO é global, e é ele que fornece o RolesGuard junto do UsersModule
// de que o guard depende. Sem este import o app inteiro deixa de subir: o
// controller usa `@UseGuards(AuthGuard, RolesGuard)`, o Nest não acha o
// UsersService para injetar no guard e aborta o bootstrap. Foi o que derrubou a
// produção em 06/08/2026 — o processo entrou em crash loop, e como o erro é de
// injeção, ele acontece na subida e não no primeiro acesso à rota.
@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
