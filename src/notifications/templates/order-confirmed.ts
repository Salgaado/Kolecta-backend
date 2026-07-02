// E-mail #1 — "Pagamento confirmado / Pedido confirmado" (para o COMPRADOR)
// Gatilho: evento `order.paid`.
import { renderLayout, formatBRL, BRAND } from './layout';

export interface OrderConfirmedData {
  buyerName: string | null;
  orderId: string;
  listingTitle: string;
  totalInCents: number;
}

export function subject(data: OrderConfirmedData): string {
  return `Pedido confirmado — ${data.listingTitle}`;
}

export function html(data: OrderConfirmedData): string {
  const greeting = data.buyerName ? `Olá, ${data.buyerName}!` : 'Olá!';
  const shortId = data.orderId.slice(0, 8).toUpperCase();
  return renderLayout({
    heading: '✅ Pagamento confirmado!',
    body: `
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">Recebemos o seu pagamento e seu pedido já foi confirmado. O vendedor foi avisado e vai preparar o envio.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;padding:16px;margin:8px 0;">
        <tr><td style="font-size:14px;color:#6b7280;padding:2px 0;">Item</td><td align="right" style="font-size:14px;font-weight:600;">${data.listingTitle}</td></tr>
        <tr><td style="font-size:14px;color:#6b7280;padding:2px 0;">Pedido</td><td align="right" style="font-size:14px;font-weight:600;">#${shortId}</td></tr>
        <tr><td style="font-size:14px;color:#6b7280;padding:2px 0;">Total</td><td align="right" style="font-size:16px;font-weight:700;color:${BRAND.color};">${formatBRL(data.totalInCents)}</td></tr>
      </table>
      <p style="margin:12px 0 0;">Você pode acompanhar o status do pedido a qualquer momento na sua conta.</p>
    `,
    ctaLabel: 'Ver meu pedido',
    ctaUrl: `${BRAND.site}/account/orders/${data.orderId}`,
  });
}
