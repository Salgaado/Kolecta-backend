import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PagarmeConfigService } from './pagarme-config.service';
import { PagarmeService } from './pagarme.service';

/**
 * Núcleo da integração Pagar.me (Fase 0).
 *
 * Exporta o client HTTP reutilizável e o config service para os módulos de
 * deposits, recebedores, saques e compras. Sem controllers nesta fase.
 */
@Module({
  imports: [HttpModule],
  providers: [PagarmeConfigService, PagarmeService],
  exports: [PagarmeService, PagarmeConfigService],
})
export class PagarmeModule {}
