import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { RecipientsService } from './recipients.service';
import { CreateRecipientDto } from './dto/create-recipient.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

// Request enriquecido pelo AuthGuard (getAuth → req.auth) / dev (req.user).
interface AuthedRequest {
  auth?: { userId?: string };
  user?: { id?: string };
}

@Controller('api/recipients')
// Sem os guards, `req.auth` NÃO é populado no @clerk/express v2 (usa getAuth),
// e todo request cairia em 401. O AuthGuard injeta req.auth; RolesGuard valida o papel.
@UseGuards(AuthGuard, RolesGuard)
export class RecipientsController {
  constructor(private readonly recipients: RecipientsService) {}

  /** Cria o recebedor na Pagar.me e retorna o link/QR de KYC (prova de vida). */
  @Post('onboard')
  @Roles('user', 'admin')
  async onboard(@Req() req: AuthedRequest, @Body() dto: CreateRecipientDto) {
    const userId = this.userId(req);
    const result = await this.recipients.onboard(userId, dto);
    return { data: result };
  }

  /** Status do recebedor/KYC do vendedor logado. */
  @Get('status')
  @Roles('user', 'admin')
  async status(@Req() req: AuthedRequest) {
    const userId = this.userId(req);
    const status = await this.recipients.getStatus(userId);
    return { data: status };
  }

  /** Gera um novo link/QR de KYC (o anterior expira em ~20min). */
  @Post('kyc-link')
  @Roles('user', 'admin')
  async kycLink(@Req() req: AuthedRequest) {
    const userId = this.userId(req);
    const kyc = await this.recipients.getKycLink(userId);
    return { data: kyc };
  }

  private userId(req: AuthedRequest): string {
    const userId = req.auth?.userId || req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('ID de usuário inexistente na sessão.');
    }
    return userId;
  }
}
