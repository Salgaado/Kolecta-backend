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

    // @clerk/express v2 — usar getAuth() ao invés de req.auth
    const auth = getAuth(request);

    // Injetar auth no request para que RolesGuard e controllers possam usar
    request.auth = auth;

    if (!auth?.userId) {
      throw new UnauthorizedException('Sua sessão expirou ou é inválida');
    }

    return true;
  }
}
