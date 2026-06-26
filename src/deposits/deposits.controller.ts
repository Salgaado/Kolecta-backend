import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { DepositsService } from './deposits.service';
import { CreateDepositDto } from './dto/deposit.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/wallet')
@UseGuards(AuthGuard, RolesGuard)
export class DepositsController {
  constructor(private readonly depositsService: DepositsService) {}

  @Post('deposit')
  @Roles('user', 'admin')
  async createDeposit(
    @Req() req: any,
    @Body() body: CreateDepositDto,
  ) {
    const userId = req.auth.userId;

    if (!body.amountInCents || body.amountInCents < 500) {
      throw new BadRequestException('O valor mínimo de depósito é R$ 5,00');
    }

    if (body.amountInCents > 100_000_00) {
      throw new BadRequestException(
        'O valor máximo por depósito é R$ 100.000,00',
      );
    }

    const result = await this.depositsService.createDeposit(
      userId,
      body.amountInCents,
      body.cpf,
      body.phone,
    );
    return { data: result };
  }
}
