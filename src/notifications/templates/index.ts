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
import * as orderShipped from './order-shipped';
import * as shippingLabelReady from './shipping-label-ready';
import * as bidReceived from './bid-received';
import * as bidOutbid from './bid-outbid';
import * as auctionWon from './auction-won';
import * as messageReceived from './message-received';
import * as payoutReleased from './payout-released';
import * as disputeOpened from './dispute-opened';
import * as avisoPagamento from './aviso-pagamento';

export interface EmailTemplate {
  subject: (data: any) => string;
  html: (data: any) => string;
  /**
   * Versão em texto puro. Não é enfeite: e-mail só com HTML perde pontos nos
   * filtros de spam e quebra para quem lê por leitor de tela.
   */
  text: (data: any) => string;
}

export const TEMPLATES = {
  'order-confirmed': orderConfirmed,
  'sale-made': saleMade,
  'kyc-approved': kycApproved,
  'kyc-action-needed': kycActionNeeded,
  welcome: welcome,
  'listing-approved': listingApproved,
  'listing-rejected': listingRejected,
  'order-shipped': orderShipped,
  'shipping-label-ready': shippingLabelReady,
  'bid-received': bidReceived,
  'bid-outbid': bidOutbid,
  'auction-won': auctionWon,
  'message-received': messageReceived,
  'payout-released': payoutReleased,
  'dispute-opened': disputeOpened,
  'aviso-pagamento': avisoPagamento,
} satisfies Record<string, EmailTemplate>;

export type TemplateSlug = keyof typeof TEMPLATES;
