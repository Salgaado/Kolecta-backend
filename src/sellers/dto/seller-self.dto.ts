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
import { COVER_OVERLAY_MAX, COVER_OVERLAY_MIN } from '../capa';

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

  /** URL da capa (banner) da loja. String vazia remove. Só aceita URL do nosso
   *  R2 — a checagem do domínio fica no service, que é quem conhece o env. */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  coverUrl?: string;

  /** Recorte vertical da capa: 0 = topo, 100 = base. */
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  coverFocalY?: number;

  /**
   * Escurecimento da capa em %. O mínimo de 35 é regra de legibilidade, não
   * estética: o nome da loja fica em cima da imagem, e sem piso a primeira foto
   * clara apaga o nome. Está aqui no DTO para que nem um request na mão passe.
   */
  @IsInt()
  @Min(COVER_OVERLAY_MIN)
  @Max(COVER_OVERLAY_MAX)
  @IsOptional()
  coverOverlay?: number;

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

/**
 * PUT /api/seller/shipping — transportadoras que o vendedor topa usar.
 *
 * Lista vazia é válida e significa "usar o padrão da plataforma". As regras de
 * negócio (serviço existir e ter cobertura nacional) ficam no service, não aqui:
 * elas dependem do MELHOR_ENVIO_SERVICOS, que muda sem deploy.
 */
export class UpdateSellerShippingDto {
  @IsArray()
  @IsInt({ each: true })
  services: number[];

  /** Entrega em mãos. Omitido = não mexe no que já estava gravado. */
  @IsBoolean()
  @IsOptional()
  acceptsPickup?: boolean;
}

/** PUT /api/seller/notification-preferences — preferências de notificação.
 *  Mapa livre: { [tipo]: { email: boolean, push: boolean } }. */
export class UpdateNotificationPrefsDto {
  @IsObject()
  prefs: Record<string, { email?: boolean; push?: boolean }>;
}
