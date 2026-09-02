import { html, text, subject, BidHoldFailedData } from './bid-hold-failed';
import { formatBRL } from './layout';

/**
 * Este e-mail existe para quebrar um silêncio, e o risco dele é assustar.
 *
 * O cron antigo tentava reter no cartão do líder a cada 6h, para sempre, e cada
 * recusa morria no log do servidor: em 24/08/2026 um comprador viu 16 tentativas
 * de R$45 aparecerem e sumirem na fatura sem nenhuma explicação, e concluiu — com
 * toda a razão — que estava sendo cobrado por algo.
 *
 * O que o e-mail precisa deixar claro, nesta ordem: o lance CONTINUA VALENDO,
 * nada foi cobrado, e a única consequência real é ter que pagar dentro do prazo
 * se arrematar. Ele não pode soar como cobrança recusada nem como lance perdido.
 */

const base: BidHoldFailedData = {
  bidderName: 'Christian Rios',
  listingId: 'listing_1',
  listingTitle: 'Hot Wheels Premium Ferrari LaFerrari',
  amountInCents: 4500,
  paymentDeadlineHours: 24,
};

describe('e-mail bid-hold-failed', () => {
  it('não diz no assunto que o lance foi recusado ou perdido', () => {
    const s = subject(base);
    expect(s).toMatch(/vale/i);
    expect(s).not.toMatch(/perdeu|perdido|cancelad|cobran[çc]a recusada/i);
  });

  it('afirma que o lance continua valendo, nos dois formatos', () => {
    expect(html(base)).toMatch(/continua valendo/i);
    expect(text(base)).toMatch(/continua valendo/i);
  });

  // O ponto que evita o mal-entendido de 24/08: tentativa de retenção não é
  // cobrança, e quem viu a fatura precisa ler isso em letras claras.
  it('afirma que NADA foi cobrado', () => {
    expect(html(base)).toMatch(/[Nn]ada foi cobrado/);
    expect(text(base)).toMatch(/[Nn]ada foi cobrado/);
  });

  it('avisa do prazo de pagamento — a única consequência real', () => {
    expect(html(base)).toContain('24h');
    expect(text(base)).toContain('24h');
  });

  // Compara com o próprio formatBRL: o separador que o Intl usa entre "R$" e o
  // número é NBSP e muda com a versão do ICU — cravar a string quebraria sozinho.
  it('mostra o valor do lance', () => {
    expect(html(base)).toContain(formatBRL(4500));
    expect(text(base)).toContain(formatBRL(4500));
  });

  it('leva ao cartão salvo, que é o que a pessoa pode consertar', () => {
    expect(html(base)).toContain('/conta/pagamentos');
  });

  it('escapa o título do anúncio', () => {
    const perigoso = { ...base, listingTitle: '<script>alert(1)</script>' };
    expect(html(perigoso)).not.toContain('<script>');
  });

  it('não quebra sem nome do licitante', () => {
    expect(() => html({ ...base, bidderName: null })).not.toThrow();
    expect(() => text({ ...base, bidderName: null })).not.toThrow();
  });
});
