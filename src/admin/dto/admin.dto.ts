import { IsEmail, IsIn, IsOptional, IsString } from 'class-validator';
import { TEMPLATES } from '../../notifications/templates';
// `import type` obrigatório: o tipo é usado num campo decorado e, com
// isolatedModules + emitDecoratorMetadata, o TS exige a forma type-only.
import type { TemplateSlug } from '../../notifications/templates';

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

  /**
   * Template a renderizar. Default: `kyc-approved` (não depende de pedido).
   * A lista vem do próprio registro de templates — registrar um novo já o
   * habilita aqui, sem uma segunda lista para esquecer de atualizar.
   */
  @IsOptional()
  @IsIn(Object.keys(TEMPLATES))
  template?: TemplateSlug;
}
