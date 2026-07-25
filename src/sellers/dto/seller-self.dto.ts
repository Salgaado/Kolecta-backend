import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** PUT /api/seller/profile — dados públicos da loja. */
export class UpdateSellerProfileDto {
  @IsString()
  @IsOptional()
  @MaxLength(120)
  storeName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  bio?: string;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  city?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2)
  state?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  website?: string;

  /** URL da foto da loja (R2 ou Clerk). String vazia remove a foto. */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  avatarUrl?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  categories?: string[];
}

/** PUT /api/seller/policies — políticas da loja. */
export class UpdateSellerPoliciesDto {
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  shipping?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  returns?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  payment?: string;

  @IsBoolean()
  @IsOptional()
  acceptOffers?: boolean;

  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  maxDiscountPercent?: number;
}

/** PUT /api/seller/notification-preferences — preferências de notificação.
 *  Mapa livre: { [tipo]: { email: boolean, push: boolean } }. */
export class UpdateNotificationPrefsDto {
  @IsObject()
  prefs: Record<string, { email?: boolean; push?: boolean }>;
}
