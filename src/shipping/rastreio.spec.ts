import { interpretarRastreio, dataMEParaDate } from './rastreio';

/**
 * O que estes testes prendem é o mapeamento do estado do envio para a etapa que
 * o comprador vê, e os casos de borda que enganam: a data-zero do Melhor Envio,
 * o envio cancelado depois de postado, e o fuso que adiantaria a entrega em 3h.
 */

describe('interpretarRastreio', () => {
  it('envio real postado (dado de produção): etapa "postado"', () => {
    const r = interpretarRastreio({
      status: 'posted',
      tracking: 'AP299649960BR',
      generated_at: '2026-08-03 15:19:57',
      posted_at: '2026-08-04 14:18:16',
      delivered_at: null,
      canceled_at: null,
    });
    expect(r.etapaAtual).toBe('postado');
    expect(r.codigo).toBe('AP299649960BR');
    expect(r.entregueEm).toBeNull();
    expect(r.marcos.map((m) => m.etapa)).toEqual(['emitida', 'postado']);
  });

  it('entregue: etapa "entregue" e a data de entrega preenchida', () => {
    const r = interpretarRastreio({
      status: 'delivered',
      tracking: 'AP299649960BR',
      generated_at: '2026-08-03 15:19:57',
      posted_at: '2026-08-04 14:18:16',
      delivered_at: '2026-08-07 11:02:00',
    });
    expect(r.etapaAtual).toBe('entregue');
    expect(r.entregueEm).toBe('2026-08-07 11:02:00');
    expect(r.marcos.map((m) => m.etapa)).toEqual(['emitida', 'postado', 'entregue']);
  });

  it('data-zero do Melhor Envio conta como não-acontecido', () => {
    // O ME manda "0000-00-00 00:00:00" para o marco que ainda não veio; tratar
    // isso como data real mostraria "entregue em 31/12/-001".
    const r = interpretarRastreio({
      status: 'posted',
      generated_at: '2026-08-03 15:19:57',
      posted_at: '2026-08-04 14:18:16',
      delivered_at: '0000-00-00 00:00:00',
    });
    expect(r.entregueEm).toBeNull();
    expect(r.etapaAtual).toBe('postado');
  });

  it('cancelado depois de postado NÃO fica "postado"', () => {
    const r = interpretarRastreio({
      status: 'canceled',
      posted_at: '2026-08-04 14:18:16',
      canceled_at: '2026-08-05 09:00:00',
    });
    expect(r.etapaAtual).toBe('cancelado');
    expect(r.canceladoEm).toBe('2026-08-05 09:00:00');
  });

  it('expirado é tratado como cancelado', () => {
    const r = interpretarRastreio({ status: 'expired', expired_at: '2026-08-10 00:00:00' });
    expect(r.etapaAtual).toBe('cancelado');
    expect(r.canceladoEm).toBe('2026-08-10 00:00:00');
  });

  it('sem nenhum marco: pendente', () => {
    expect(interpretarRastreio({ status: 'pending' }).etapaAtual).toBe('pendente');
    expect(interpretarRastreio(null).etapaAtual).toBe('pendente');
    expect(interpretarRastreio(undefined).codigo).toBeNull();
  });
});

describe('dataMEParaDate', () => {
  it('interpreta como horário de Brasília (UTC-3), não UTC', () => {
    // 14:18 em Brasília é 17:18 em UTC. Sem fixar o offset, o servidor leria
    // 14:18 UTC e a hora exibida ao usuário sairia 3h errada.
    const d = dataMEParaDate('2026-08-04 14:18:16')!;
    expect(d.toISOString()).toBe('2026-08-04T17:18:16.000Z');
  });

  it('data-zero e vazio viram null', () => {
    expect(dataMEParaDate('0000-00-00 00:00:00')).toBeNull();
    expect(dataMEParaDate(null)).toBeNull();
    expect(dataMEParaDate('')).toBeNull();
  });
});
