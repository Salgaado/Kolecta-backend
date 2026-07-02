import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { RecipientsService } from './recipients.service';
import { CreateRecipientDto } from './dto/create-recipient.dto';

// Request enriquecido pelo middleware de auth do Clerk (req.auth) / dev (req.user).
interface AuthedRequest {
  auth?: { userId?: string };
  user?: { id?: string };
}

@Controller('api/recipients')
export class RecipientsController {
  constructor(private readonly recipients: RecipientsService) {}

  /** Cria o recebedor na Pagar.me e retorna o link/QR de KYC (prova de vida). */
  @Post('onboard')
  async onboard(@Req() req: AuthedRequest, @Body() dto: CreateRecipientDto) {
    const userId = this.userId(req);
    const result = await this.recipients.onboard(userId, dto);
    return { data: result };
  }

  /** Status do recebedor/KYC do vendedor logado. */
  @Get('status')
  async status(@Req() req: AuthedRequest) {
    const userId = this.userId(req);
    const status = await this.recipients.getStatus(userId);
    return { data: status };
  }

  /** Gera um novo link/QR de KYC (o anterior expira em ~20min). */
  @Post('kyc-link')
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
