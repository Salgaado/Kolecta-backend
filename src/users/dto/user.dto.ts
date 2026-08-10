import { IsOptional, IsString } from 'class-validator';

// PATCH /api/users/me (self-service): o usuário pode alterar o próprio nome e
// telefone. `role` foi deliberadamente OMITIDO — mudanças de role passam por
// /api/admin/users/:id/role (@Roles('admin')). Como o ValidationPipe global usa
// whitelist:true, qualquer `role` enviado aqui é descartado antes de chegar ao service.
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  // Telefone com DDD. Aceita máscara; o service normaliza para só dígitos e
  // valida 10–11 (fixo/celular BR). É o número captado no cadastro e reusado no
  // contato da Pagar.me.
  @IsOptional()
  @IsString()
  phone?: string;
}
