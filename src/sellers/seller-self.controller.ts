import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { SellersService } from './sellers.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  UpdateNotificationPrefsDto,
  UpdateSellerPoliciesDto,
  UpdateSellerProfileDto,
  UpdateSellerShippingDto,
} from './dto/seller-self.dto';

/**
 * Endpoints autenticados do PRÓPRIO vendedor (perfil da loja, políticas,
 * preferências de notificação). Separado do `api/sellers/:id` público.
 */
@Controller('api/seller')
@UseGuards(AuthGuard, RolesGuard)
export class SellerSelfController {
  constructor(private readonly sellersService: SellersService) {}

  @Get('profile')
  @Roles('user', 'admin')
  async getMyProfile(@Req() req: any) {
    const data = await this.sellersService.getMyProfile(req.auth.userId);
    return { data };
  }

  @Put('profile')
  @Roles('user', 'admin')
  async updateMyProfile(@Req() req: any, @Body() dto: UpdateSellerProfileDto) {
    const data = await this.sellersService.updateMyProfile(req.auth.userId, dto);
    return { data };
  }

  @Put('policies')
  @Roles('user', 'admin')
  async updateMyPolicies(@Req() req: any, @Body() dto: UpdateSellerPoliciesDto) {
    const data = await this.sellersService.updateMyPolicies(req.auth.userId, dto);
    return { data };
  }

  /**
   * Transportadoras com que este vendedor topa trabalhar.
   *
   * Só RESTRINGE o que a plataforma já libera: a cotação cruza as duas listas.
   * Existe porque a agência perto da casa do vendedor é o que decide se ele
   * consegue despachar, e antes ele recebia as seis opções e se virava.
   */
  @Put('shipping')
  @Roles('user', 'admin')
  async updateMyShipping(@Req() req: any, @Body() dto: UpdateSellerShippingDto) {
    const data = await this.sellersService.updateMyShipping(
      req.auth.userId,
      dto.services,
      dto.acceptsPickup,
    );
    return { data };
  }

  @Put('notification-preferences')
  @Roles('user', 'admin')
  async updateMyNotificationPrefs(
    @Req() req: any,
    @Body() dto: UpdateNotificationPrefsDto,
  ) {
    const data = await this.sellersService.updateMyNotificationPrefs(
      req.auth.userId,
      dto.prefs,
    );
    return { data };
  }
}
