import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

/**
 * DevAuthMiddleware — injeta req.auth mock quando NODE_ENV !== 'production'.
 * Em produção o Clerk preenche req.auth normalmente.
 *
 * Lê o header 'x-dev-user-id' para definir qual userId usar.
 * Fallback: 'seller-001' (o mock seller do frontend).
 */
@Injectable()
export class DevAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(DevAuthMiddleware.name);

  use(req: Request, _res: Response, next: NextFunction) {
    // Se o Clerk já preencheu req.auth, não faz nada
    if ((req as any).auth?.userId) {
      return next();
    }

    // Apenas em ambiente de desenvolvimento
    if (process.env.NODE_ENV === 'production') {
      return next();
    }

    const devUserId = (req.headers['x-dev-user-id'] as string) || 'seller-001';

    (req as any).auth = { userId: devUserId };
    this.logger.debug(`[DEV] Auth mockado → userId=${devUserId}`);

    next();
  }
}
