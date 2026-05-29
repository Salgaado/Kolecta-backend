export class UpdateUserRoleDto {
  role: 'user' | 'admin';
}

export class ResolveDisputeDto {
  status: 'under_review' | 'resolved' | 'closed';
  resolution?: string;
}
