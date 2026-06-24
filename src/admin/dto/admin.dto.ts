import { IsIn, IsOptional, IsString } from 'class-validator';

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
