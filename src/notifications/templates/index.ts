// Registro central de templates de e-mail.
// Cada entrada expõe `subject(data)` e `html(data)`.
// Adicionar um e-mail novo = criar o arquivo do template + 1 linha aqui.
import * as orderConfirmed from './order-confirmed';
import * as saleMade from './sale-made';
import * as kycApproved from './kyc-approved';
import * as kycActionNeeded from './kyc-action-needed';
import * as welcome from './welcome';
import * as listingApproved from './listing-approved';
import * as listingRejected from './listing-rejected';

export interface EmailTemplate {
  subject: (data: any) => string;
  html: (data: any) => string;
}

export const TEMPLATES = {
  'order-confirmed': orderConfirmed,
  'sale-made': saleMade,
  'kyc-approved': kycApproved,
  'kyc-action-needed': kycActionNeeded,
  welcome: welcome,
  'listing-approved': listingApproved,
  'listing-rejected': listingRejected,
} satisfies Record<string, EmailTemplate>;

export type TemplateSlug = keyof typeof TEMPLATES;
