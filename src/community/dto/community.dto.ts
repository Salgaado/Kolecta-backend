import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const POST_TYPES = ['collection', 'product', 'discussion', 'guide'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const REPORT_REASONS = [
  'spam',
  'scam',
  'fake_product',
  'offensive',
  'off_topic',
  'external_ads',
  'prohibited',
] as const;

export class CreatePostDto {
  @IsIn(POST_TYPES)
  type: PostType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  body?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(8)
  images?: string[];

  @IsOptional()
  @IsString()
  categoryId?: string;

  // Obrigatório (validado no service) quando type === 'product'
  @IsOptional()
  @IsString()
  listingId?: string;
}

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  body?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(8)
  images?: string[];

  @IsOptional()
  @IsString()
  categoryId?: string;
}

export class CreateCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;

  /**
   * Anúncio mencionado, opcional.
   *
   * UM por comentário, de propósito: sem esse limite o campo viraria vitrine e
   * a comunidade voltaria a ser lugar de divulgação, que é justamente o que a
   * regra de link externo foi criada para impedir.
   */
  @IsString()
  @IsOptional()
  listingId?: string;
}

export class CreateReportDto {
  @IsIn(['post', 'comment'])
  targetType: 'post' | 'comment';

  @IsString()
  @IsNotEmpty()
  targetId: string;

  @IsIn(REPORT_REASONS)
  reason: (typeof REPORT_REASONS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class BanUserDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
