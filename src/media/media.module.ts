import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [MediaController],
  providers: [MediaService],
  // A importação do Bling precisa copiar as fotos do ERP para o nosso R2: as
  // URLs de lá são assinadas e expiram em 7 dias.
  exports: [MediaService],
})
export class MediaModule {}
