import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { TEMPLATES } from '../../notifications/templates';
// `import type` obrigatório: o tipo é usado num campo decorado e, com
// isolatedModules + emitDecoratorMetadata, o TS exige a forma type-only.
import type { TemplateSlug } from '../../notifications/templates';
// Mesmo motivo do import acima: usado em campo decorado, precisa ser type-only.
import type { Audiencia } from '../../notifications/broadcast.service';

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

/**
 * Comunicado para toda a base. Só admin.
 *
 * `dryRun` é opcional de propósito e vale `true` quando ausente: uma chamada
 * malfeita ou um curioso batendo no endpoint recebe a contagem, não um disparo
 * para centenas de pessoas.
 */
export class BroadcastDto {
  @IsIn(Object.keys(TEMPLATES))
  template: TemplateSlug;

  /**
   * Identificador da campanha. Vira o refId de cada envio, e é o que garante
   * que ninguém receba a mesma mensagem duas vezes. Use algo estável e datado,
   * ex: "aviso-pagamento-2026-07-30".
   */
  @IsString()
  @IsNotEmpty()
  campanha: string;

  /** Só envia de verdade com `false` explícito. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /** Restringe a um único endereço, para conferir o e-mail antes da base. */
  @IsOptional()
  @IsEmail({}, { message: 'apenasPara precisa ser um e-mail válido.' })
  apenasPara?: string;

  /**
   * Recorte do público. Omitido = `todos` (toda a base).
   * `recebedores-a-recadastrar` mira só os vendedores cujo recebedor Pagar.me
   * morre na troca de conta — ver `docs/PLAN-pagarme-conta-nova.md` (Fase 4).
   */
  @IsOptional()
  @IsIn(['todos', 'recebedores-a-recadastrar'])
  audiencia?: Audiencia;

  /** Corta a lista nos N primeiros — útil para um lote piloto. */
  @IsOptional()
  @IsInt()
  @Min(1)
  limite?: number;

  /** Pausa entre envios, em ms. Abaixo de ~500 a Resend começa a devolver 429. */
  @IsOptional()
  @IsInt()
  @Min(0)
  pausaMs?: number;
}

/**
 * Conciliação manual de um pedido contra a API da Pagar.me.
 *
 * `pagarmeOrderId` é opcional: por padrão usa a referência guardada no pedido.
 * Informe-a quando ela for nula — o caso de uma cobrança recusada, em que o id
 * da order era descartado junto com a exceção.
 */
export class ConciliarOrderDto {
  @IsOptional()
  @IsString()
  pagarmeOrderId?: string;
}
