import {
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
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

@Controller('api/media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  // POST /api/media/upload — campo multipart: "file"
  @Post('upload')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
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
