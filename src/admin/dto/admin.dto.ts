import { IsEmail, IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateUserRoleDto {
  @IsIn(['user', 'admin'])
  role: 'user' | 'admin';
}

export class ResolveDisputeDto {
  @IsIn(['under_review', 'resolved', 'closed'])
  status: 'under_review' | 'resolved' | 'closed';

  @IsOptional()
  @IsString()
  resolution?: string;
}

/**
 * Disparo manual de e-mail para validar a configuração do provedor (Resend) no
 * ambiente — chave, remetente e domínio verificado. Só admin.
 */
export class SendTestEmailDto {
  @IsEmail({}, { message: 'Informe um e-mail de destino válido.' })
  to: string;

  /** Template a renderizar. Default: `kyc-approved` (não depende de pedido). */
  @IsOptional()
  @IsIn(['kyc-approved', 'kyc-action-needed', 'order-confirmed', 'sale-made'])
  template?: 'kyc-approved' | 'kyc-action-needed' | 'order-confirmed' | 'sale-made';
}
