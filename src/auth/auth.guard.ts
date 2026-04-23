import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger('AuthGuard');

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();

    // O middleware do clerk injeta os dados do auth (@clerk/express)
    const auth = request.auth;

    // ── DEBUG TEMPORÁRIO (remover depois) ──────────────────────
    const hasAuthHeader = !!request.headers?.authorization;
    this.logger.warn(
      `[DEBUG] path=${request.url} | hasAuthHeader=${hasAuthHeader} | auth=${JSON.stringify(auth ?? 'undefined')} | NODE_ENV=${process.env.NODE_ENV} | hasClerkSecret=${!!process.env.CLERK_SECRET_KEY}`,
    );
    // ── FIM DEBUG ──────────────────────────────────────────────

    if (!auth || !auth.userId) {
      throw new UnauthorizedException('Sua sessão expirou ou é inválida');
    }

    return true; // Autenticado via Clerk
  }
}
