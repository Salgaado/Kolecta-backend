/**
 * Reserva de listing no checkout.
 *
 * A regra é curta e cara: só a PEÇA ÚNICA (stock nulo) vira pending_payment no
 * checkout. Item com estoque segue active, senão a primeira compra tira do ar um
 * anúncio com estoque de sobra — foi o que sumiu a Mystery Bag de 99 unidades
 * logo depois da primeira venda.
 */

import { OrdersService } from './orders.service';

describe('OrdersService.reservaListingNoCheckout', () => {
  it('peça única (stock nulo) é reservada em pending_payment', () => {
    expect(OrdersService.reservaListingNoCheckout({ stock: null })).toBe(true);
  });

  it('item com estoque NÃO é reservado — segue active', () => {
    expect(OrdersService.reservaListingNoCheckout({ stock: 99 })).toBe(false);
    expect(OrdersService.reservaListingNoCheckout({ stock: 1 })).toBe(false);
  });

  it('estoque zerado também não reserva (quem pausa é a baixa de estoque)', () => {
    // Um anúncio com stock 0 já saiu do ar como paused pela baixa; o checkout
    // nem chega aqui, mas a regra não deve tratá-lo como peça única.
    expect(OrdersService.reservaListingNoCheckout({ stock: 0 })).toBe(false);
  });
});
