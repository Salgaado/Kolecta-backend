import { Module } from '@nestjs/common';
import { TinyService } from './tiny.service';
import { TinyController } from './tiny.controller';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Fase 1 do docs/PLAN-tiny-olist.md: só a conexão OAuth.
 *
 * Sem `MediaModule` porque não há importação de foto ainda, e sem serviço de
 * estoque ou de pedido porque as duas coisas dependem de medir a API real —
 * ver o "⚠️" do plano.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [TinyController],
  providers: [TinyService],
  exports: [TinyService],
})
export class TinyModule {}
