// E-mail #2 — "Você fez uma venda!" (para o VENDEDOR)
// Gatilho: evento `order.paid`.
import { renderLayout, formatBRL, BRAND } from './layout';

export interface SaleMadeData {
  sellerName: string | null;
  orderId: string;
  listingTitle: string;
  /** Valor bruto da venda (centavos). */
  totalInCents: number;
}

export function subject(data: SaleMadeData): string {
  return `🎉 Você vendeu: ${data.listingTitle}`;
}

export function html(data: SaleMadeData): string {
  const greeting = data.sellerName ? `Olá, ${data.sellerName}!` : 'Olá!';
  const shortId = data.orderId.slice(0, 8).toUpperCase();
  return renderLayout({
    heading: '🎉 Você fez uma venda!',
    body: `
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">Boas notícias: <strong>${data.listingTitle}</strong> foi vendido e o pagamento já foi confirmado. Agora é com você: prepare o item e faça o envio.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;padding:16px;margin:8px 0;">
        <tr><td style="font-size:14px;color:#6b7280;padding:2px 0;">Item</td><td align="right" style="font-size:14px;font-weight:600;">${data.listingTitle}</td></tr>
        <tr><td style="font-size:14px;color:#6b7280;padding:2px 0;">Pedido</td><td align="right" style="font-size:14px;font-weight:600;">#${shortId}</td></tr>
        <tr><td style="font-size:14px;color:#6b7280;padding:2px 0;">Valor da venda</td><td align="right" style="font-size:16px;font-weight:700;color:${BRAND.color};">${formatBRL(data.totalInCents)}</td></tr>
      </table>
      <p style="margin:12px 0 0;font-size:13px;color:#6b7280;">O valor fica retido com segurança e é liberado para saque após a confirmação de entrega.</p>
    `,
    ctaLabel: 'Gerenciar venda',
    ctaUrl: `${BRAND.site}/painel/pedidos/${data.orderId}`,
  });
}
