import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { MulterError } from 'multer';
import type { Response } from 'express';

// ─── Erro de upload em linguagem de gente ────────────────────────────────────
//
// Quando a foto estoura o limite do multer, o vendedor recebia o erro cru do
// parser ("Multipart: Unexpected end of form"), que não diz o que fazer. Este
// filtro traduz os erros de multipart/tamanho numa mensagem acionável, e deixa
// qualquer outra exceção seguir com o formato padrão do Nest.
@Catch()
export class UploadExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const msg = exception instanceof Error ? exception.message : '';
    const ehMulter = exception instanceof MulterError;
    // O busboy (dentro do multer) lança "Unexpected end of form" quando o corpo
    // chega cortado, que é o que acontece quando a foto passa do limite.
    const ehMultipart = /multipart|unexpected end of (form|multipart)/i.test(msg);

    if (ehMulter || ehMultipart) {
      const grande = ehMulter && (exception as MulterError).code === 'LIMIT_FILE_SIZE';
      const status = grande ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST;
      res.status(status).json({
        statusCode: status,
        error: grande ? 'Payload Too Large' : 'Bad Request',
        message: 'A imagem é muito grande para enviar. Tente uma foto menor ou com menos resolução.',
      });
      return;
    }

    // Não é erro de upload: mantém o comportamento padrão do Nest.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const corpo = exception.getResponse();
      res.status(status).json(
        typeof corpo === 'string' ? { statusCode: status, message: corpo } : corpo,
      );
      return;
    }

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Erro interno ao processar o upload.',
    });
  }
}
