import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { getAuth } from '@clerk/express';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger('AuthGuard');

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // @clerk/express v2 — usar getAuth() ao invés de req.auth
    const auth = getAuth(request);

    // Injetar auth no request para que RolesGuard e controllers possam usar
    request.auth = auth;

    if (!auth?.userId) {
      this.logger.warn(
        `[401] path=${request.url} | userId=${auth?.userId ?? 'null'} | sessionId=${auth?.sessionId ?? 'null'}`,
      );
      throw new UnauthorizedException('Sua sessão expirou ou é inválida');
    }

    return true;
  }
}
