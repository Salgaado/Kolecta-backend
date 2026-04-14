import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { UsersService } from '../users/users.service';

/**
 * RolesGuard — usado APÓS AuthGuard.
 * Lê a role do usuário diretamente do Turso (fonte de verdade),
 * garantindo que mudanças de role via webhook sejam respeitadas imediatamente.
 *
 * Uso:
 *   @UseGuards(AuthGuard, RolesGuard)
 *   @Roles('user')
 *   async createListing() {}
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Verificar se a rota tem @Roles definido
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Se a rota não tem @Roles, qualquer usuário autenticado pode acessar
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    // 2. Pegar userId do Clerk (já validado pelo AuthGuard)
    const request = context.switchToHttp().getRequest();
    const userId = request.auth?.userId as string;

    if (!userId) {
      throw new ForbiddenException('Usuário não identificado.');
    }

    // 3. Buscar role atual no Turso (fonte de verdade)
    const user = await this.usersService.findById(userId);

    this.logger.debug(
      `[RolesGuard] userId=${userId} | role=${user.role} | required=${requiredRoles.join(',')}`,
    );

    // 4. Verificar se a role do usuário satisfaz alguma das roles exigidas
    const hasRole = requiredRoles.includes(user.role);

    if (!hasRole) {
      throw new ForbiddenException(
        `Acesso negado. Necessário: [${requiredRoles.join(', ')}]. Seu perfil: ${user.role}.`,
      );
    }

    return true;
  }
}
