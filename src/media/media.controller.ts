import {
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  UseFilters,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { MediaService } from './media.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UploadExceptionFilter } from './upload-exception.filter';

// Teto do arquivo cru. Foto de celular moderno passa de 5 MB fácil (iPhone/iPad
// chega a 8 MB), e o front já comprime antes de subir, então 15 MB dá folga sem
// abrir a porta para abuso.
const LIMITE_UPLOAD_BYTES = 15 * 1024 * 1024;

@Controller('api/media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  // POST /api/media/upload — campo multipart: "file"
  @Post('upload')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.CREATED)
  @UseFilters(UploadExceptionFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: LIMITE_UPLOAD_BYTES, files: 1 },
    }),
  )
  async upload(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('Nenhum arquivo enviado.');
    const sellerId = (req as any).auth.userId as string;
    return this.mediaService.uploadImage(file, sellerId);
  }
}
