import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { extname } from 'path';

const ALLOWED_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor() {
    const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
    this.bucket = process.env.CLOUDFLARE_R2_BUCKET_NAME!;
    this.publicUrl = process.env.CLOUDFLARE_R2_PUBLIC_URL!;

    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
      },
    });
  }

  /**
   * Copia uma imagem de fora para o nosso R2 e devolve a URL nossa.
   *
   * Existe por causa da importação do Bling. As fotos de lá vêm em URL ASSINADA
   * da S3 deles, com validade de 7 dias (campo `validade`, e `Expires` na
   * própria query string). Guardar esse link no anúncio faria toda foto
   * importada morrer na semana seguinte, e o vendedor descobriria pela vitrine.
   *
   * Devolve `null` em vez de estourar: uma foto que não veio não pode derrubar
   * a importação inteira. Quem chama decide o que fazer com o que sobrou.
   */
  async copiarDeUrl(url: string, sellerId: string): Promise<string | null> {
    try {
      const resposta = await fetch(url);
      if (!resposta.ok) {
        this.logger.warn(`Imagem externa respondeu ${resposta.status}: ${url.slice(0, 90)}`);
        return null;
      }

      const tipo = (resposta.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!ALLOWED_MIMETYPES.includes(tipo)) {
        this.logger.warn(`Imagem externa em formato não aceito (${tipo}): ${url.slice(0, 90)}`);
        return null;
      }

      const bytes = Buffer.from(await resposta.arrayBuffer());
      if (bytes.length > MAX_SIZE_BYTES) {
        this.logger.warn(
          `Imagem externa maior que o limite (${Math.round(bytes.length / 1024)} KB): ${url.slice(0, 90)}`,
        );
        return null;
      }

      const key = `uploads/${sellerId}/${randomUUID()}${this.mimeToExt(tipo)}`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: tipo,
          ContentLength: bytes.length,
        }),
      );
      return `${this.publicUrl}/${key}`;
    } catch (err: any) {
      this.logger.warn(`Falha ao copiar imagem externa: ${err?.message ?? err}`);
      return null;
    }
  }

  async uploadImage(
    file: Express.Multer.File,
    sellerId: string,
  ): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('Nenhum arquivo enviado.');

    if (file.size > MAX_SIZE_BYTES)
      throw new BadRequestException('Arquivo muito grande. Limite: 5 MB.');

    if (!ALLOWED_MIMETYPES.includes(file.mimetype))
      throw new BadRequestException('Formato inválido. Use JPG, PNG ou WebP.');

    const ext =
      extname(file.originalname).toLowerCase() || this.mimeToExt(file.mimetype);
    const key = `uploads/${sellerId}/${randomUUID()}${ext}`;

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
          ContentLength: file.size,
        }),
      );
    } catch (err) {
      this.logger.error('Falha ao enviar arquivo para o R2', err);
      throw new InternalServerErrorException('Erro ao fazer upload. Tente novamente.');
    }

    const url = `${this.publicUrl}/${key}`;
    this.logger.log(`Upload concluído: ${url}`);
    return { url };
  }

  private mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
    };
    return map[mime] ?? '.jpg';
  }
}
