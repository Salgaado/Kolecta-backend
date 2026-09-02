import {
  html,
  text,
  subject,
  AuctionReserveNotMetData,
} from './auction-reserve-not-met';
import { formatBRL } from './layout';

/**
 * O e-mail existe para desfazer uma expectativa errada, então o que ele NÃO diz
 * importa tanto quanto o que diz.
 *
 * Quem deu o maior lance abaixo da reserva não arrematou: não nasce pedido e a
 * retenção no cartão cai. Mas até 01/09/2026 nada dizia isso a ele — "Meus
 * Lances" o tratava como arrematante ("Escolha o frete") e a página do leilão
 * escondia o aviso de reserva justamente ao encerrar. Dois compradores ficaram
 * esperando uma entrega que nunca ia existir.
 *
 * Por isso o e-mail não pode mandá-lo a "Meus Pedidos" (está vazio) nem falar
 * em frete, pagamento ou arremate.
 */

const base: AuctionReserveNotMetData = {
  bidderName: 'Carlos Neandro',
  listingId: 'listing_1',
  listingTitle: 'Hot Wheels 1/43 Ferrari F300 Schumacher',
  topBidInCents: 1100,
  reservePriceInCents: 25000,
};

describe('e-mail auction-reserve-not-met', () => {
  it('diz no assunto que encerrou SEM VENDA, sem dar a entender arremate', () => {
    const s = subject(base);
    expect(s).toContain('sem venda');
    expect(s).not.toMatch(/arremat|parabéns|venceu/i);
  });

  // Compara com o próprio formatBRL: o separador que o Intl usa entre "R$" e o
  // número é NBSP e muda com a versão do ICU — cravar a string quebraria sozinho.
  it('mostra os dois números que explicam o desfecho', () => {
    for (const corpo of [html(base), text(base)]) {
      expect(corpo).toContain(formatBRL(1100)); // o lance dele
      expect(corpo).toContain(formatBRL(25000)); // a reserva do vendedor
    }
  });

  it('afirma que nada foi cobrado — é a dúvida imediata de quem teve retenção', () => {
    expect(html(base)).toMatch(/liberada/i);
    expect(text(base)).toMatch(/nada foi cobrado/i);
  });

  it('NÃO manda para Meus Pedidos nem fala em escolher frete', () => {
    for (const corpo of [html(base), text(base)]) {
      expect(corpo).not.toContain('/conta/pedidos');
      expect(corpo).not.toMatch(/escolh\w+ (o )?frete/i);
    }
  });

  it('escapa o título do anúncio, que é texto do vendedor', () => {
    const corpo = html({ ...base, listingTitle: '<script>x</script>' });
    expect(corpo).not.toContain('<script>');
    expect(corpo).toContain('&lt;script&gt;');
  });

  it('não quebra quando o comprador não tem nome cadastrado', () => {
    expect(() => html({ ...base, bidderName: null })).not.toThrow();
    expect(() => text({ ...base, bidderName: null })).not.toThrow();
  });
});
