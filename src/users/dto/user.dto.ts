import { IsOptional, IsString } from 'class-validator';

// PATCH /api/users/me (self-service): o usuário só pode alterar o próprio nome.
// `role` foi deliberadamente OMITIDO — mudanças de role passam por
// /api/admin/users/:id/role (@Roles('admin')). Como o ValidationPipe global usa
// whitelist:true, qualquer `role` enviado aqui é descartado antes de chegar ao service.
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;
}
