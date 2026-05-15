import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { getAuth } from '@clerk/express';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // Se o DevAuthMiddleware já injetou o mock de desenvolvimento, apenas aceite
    if (request.auth && request.auth.userId && process.env.NODE_ENV !== 'production') {
      return true;
    }

    try {
      // @clerk/express v2 — usar getAuth() ao invés de req.auth
      const auth = getAuth(request);

      // Injetar auth no request para que RolesGuard e controllers possam usar
      request.auth = auth;

      if (!auth?.userId) {
        throw new UnauthorizedException('Sua sessão expirou ou é inválida');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Falha na autenticação (Clerk não configurado ou mock ausente)');
    }

    return true;
  }
}
