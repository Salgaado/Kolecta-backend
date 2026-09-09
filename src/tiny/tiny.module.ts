import { Module } from '@nestjs/common';
import { TinyService } from './tiny.service';
import { TinyImportService } from './tiny-import.service';
import { TinyEstoqueService } from './tiny-estoque.service';
import { TinyController } from './tiny.controller';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';

/**
 * Integração com o Tiny (Olist ERP), espelhando o `BlingModule`: conexão OAuth
 * (Fase 1) + catálogo, importação e sincronização de estoque (Fases 2-3).
 *
 * `MediaModule` entra porque a importação copia as fotos do ERP para o nosso R2.
 * O cron de estoque usa o `ScheduleModule`, registrado globalmente no AppModule
 * (mesmo arranjo do Bling).
 */
@Module({
  imports: [DatabaseModule, AuthModule, MediaModule],
  controllers: [TinyController],
  providers: [TinyService, TinyImportService, TinyEstoqueService],
  exports: [TinyService],
})
export class TinyModule {}
