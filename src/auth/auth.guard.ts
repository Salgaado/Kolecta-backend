import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();

    // O middleware do clerk injeta os dados do auth (@clerk/express)
    const auth = request.auth;

    if (!auth || !auth.userId) {
      throw new UnauthorizedException('Sua sessão expirou ou é inválida');
    }

    return true; // Autenticado via Clerk
  }
}
