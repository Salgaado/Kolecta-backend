import { IsISO8601, IsNotEmpty, IsString } from 'class-validator';

// POST /api/users/me/consent — registra o aceite de Termos + LGPD feito no
// modal de cadastro (T10). O momento real do aceite vem do cliente (ocorre antes
// da conta existir); o servidor grava versão + timestamps para auditoria LGPD.
export class RecordConsentDto {
  @IsString()
  @IsNotEmpty()
  termsVersion: string;

  @IsISO8601()
  termsAcceptedAt: string;

  @IsISO8601()
  lgpdAcceptedAt: string;
}
