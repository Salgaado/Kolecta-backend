import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConciliacaoService, eventoDeOrderPaga } from './conciliacao.service';
import { PagarmeService } from './pagarme.service';
import { DATABASE_CONNECTION } from '../database/database.module';

/**
 * A conciliação existe porque o webhook é push, e todo modo de falha dele está
 * fora do nosso controle. Em 12/08 ele chegou, foi gravado como `processed` e
 * não fez nada — então a fonte de verdade aqui é a API da Pagar.me, NUNCA a
 * nossa tabela de eventos.
 */
const mockPagarme = { get: jest.fn(), delete: jest.fn() };

const makeDb = () => {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue([]);
  return chain;
};

describe('eventoDeOrderPaga', () => {
  it('arremate vai para o evento do leilão', () => {
    expect(eventoDeOrderPaga('bid_payment')).toBe('pagarme.auction.paid');
  });

  it('o resto vai para o do checkout', () => {
    expect(eventoDeOrderPaga('purchase')).toBe('pagarme.order.paid');
    expect(eventoDeOrderPaga(undefined)).toBe('pagarme.order.paid');
  });
});

describe('ConciliacaoService', () => {
  let service: ConciliacaoService;
  let db: any;
  let emitter: { emitAsync: jest.Mock };

  const build = async () => {
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ConciliacaoService,
        { provide: DATABASE_CONNECTION, useValue: db },
        { provide: PagarmeService, useValue: mockPagarme },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    return mod.get(ConciliacaoService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPagarme.get.mockReset();
    db = makeDb();
    emitter = { emitAsync: jest.fn().mockResolvedValue([]) };
  });

  const pedidoPendente = {
    id: 'order_1',
    status: 'pending_payment',
    pagarmeOrderId: 'or_1',
  };

  /** O caso do Billy: pago na Pagar.me, `pending_payment` aqui. */
  it('LIQUIDA quando está pago lá e pendente aqui', async () => {
    db.where.mockResolvedValueOnce([pedidoPendente]);
    mockPagarme.get.mockResolvedValueOnce({
      id: 'or_1',
      status: 'paid',
      metadata: { type: 'bid_payment', orderId: 'order_1' },
      charges: [{ id: 'ch_1', status: 'paid' }],
    });
    service = await build();

    const r = await service.conciliarPedido('order_1');

    expect(r.acao).toBe('liquidado');
    // Mesmo evento que o webhook dispararia — nada de terceiro caminho.
    expect(emitter.emitAsync).toHaveBeenCalledWith(
      'pagarme.auction.paid',
      expect.objectContaining({ id: 'or_1' }),
    );
  });

  it('compra direta paga cai no evento do checkout', async () => {
    db.where.mockResolvedValueOnce([{ ...pedidoPendente, status: 'pending' }]);
    mockPagarme.get.mockResolvedValueOnce({
      id: 'or_1',
      status: 'paid',
      metadata: { type: 'purchase', orderId: 'order_1' },
      charges: [{ id: 'ch_1', status: 'paid' }],
    });
    service = await build();

    const r = await service.conciliarPedido('order_1');

    expect(r.acao).toBe('liquidado');
    expect(emitter.emitAsync).toHaveBeenCalledWith(
      'pagarme.order.paid',
      expect.anything(),
    );
  });

  /**
   * Cobrança criada fora do nosso fluxo pode voltar sem `metadata`. O
   * `orderId` é justamente o que se sabe AQUI e não se sabe lá.
   */
  it('preenche o orderId quando a order remota vem sem metadata', async () => {
    db.where.mockResolvedValueOnce([pedidoPendente]);
    mockPagarme.get.mockResolvedValueOnce({
      id: 'or_1',
      status: 'paid',
      charges: [{ id: 'ch_1', status: 'paid' }],
    });
    service = await build();

    await service.conciliarPedido('order_1');

    expect(emitter.emitAsync).toHaveBeenCalledWith(
      'pagarme.order.paid',
      expect.objectContaining({ metadata: { orderId: 'order_1' } }),
    );
  });

  it('não mexe em pedido que já terminou', async () => {
    db.where.mockResolvedValueOnce([{ ...pedidoPendente, status: 'paid' }]);
    service = await build();

    const r = await service.conciliarPedido('order_1');

    expect(r.acao).toBe('ja-consistente');
    expect(mockPagarme.get).not.toHaveBeenCalled();
    expect(emitter.emitAsync).not.toHaveBeenCalled();
  });

  it('não liquida quando a Pagar.me também diz que não foi pago', async () => {
    db.where.mockResolvedValueOnce([pedidoPendente]);
    mockPagarme.get.mockResolvedValueOnce({
      id: 'or_1',
      status: 'failed',
      charges: [{ id: 'ch_1', status: 'failed' }],
    });
    service = await build();

    const r = await service.conciliarPedido('order_1');

    expect(r.acao).toBe('nao-pago');
    expect(emitter.emitAsync).not.toHaveBeenCalled();
  });

  /**
   * O id pode faltar: numa recusa ele era descartado junto com a exceção. Por
   * isso dá para informá-lo à mão — sem isso o conciliador nasceria cego
   * exatamente nos pedidos que existe para cobrir.
   */
  it('avisa quando não há referência, e aceita uma informada', async () => {
    db.where.mockResolvedValueOnce([
      { ...pedidoPendente, pagarmeOrderId: null },
    ]);
    service = await build();
    expect((await service.conciliarPedido('order_1')).acao).toBe(
      'sem-referencia',
    );

    db = makeDb();
    db.where.mockResolvedValueOnce([
      { ...pedidoPendente, pagarmeOrderId: null },
    ]);
    mockPagarme.get.mockResolvedValueOnce({
      id: 'or_informado',
      status: 'paid',
      metadata: { type: 'bid_payment' },
      charges: [{ id: 'ch_1', status: 'paid' }],
    });
    service = await build();

    const r = await service.conciliarPedido('order_1', 'or_informado');

    expect(mockPagarme.get).toHaveBeenCalledWith('/orders/or_informado');
    expect(r.acao).toBe('liquidado');
  });

  it('falha de consulta não vira "não pago" — são coisas diferentes', async () => {
    db.where.mockResolvedValueOnce([pedidoPendente]);
    mockPagarme.get.mockRejectedValueOnce(new Error('502'));
    service = await build();

    const r = await service.conciliarPedido('order_1');

    // Tratar erro de rede como recusa mandaria cancelar um pedido que pode
    // estar pago. O estado correto é "não sei".
    expect(r.acao).toBe('erro-consulta');
    expect(emitter.emitAsync).not.toHaveBeenCalled();
  });

  it('pedido inexistente não quebra', async () => {
    db.where.mockResolvedValueOnce([]);
    service = await build();

    expect((await service.conciliarPedido('nope')).acao).toBe('sem-referencia');
  });

  /**
   * A retenção do lance ficava de pé depois do arremate pago: o comprador
   * terminava com o valor cobrado E o valor retido comprometidos ao mesmo
   * tempo. Corrigido para os próximos; as já criadas precisam ser soltas.
   */
  describe('liberarRetencao', () => {
    it('cancela a retenção e devolve o limite', async () => {
      mockPagarme.get.mockResolvedValueOnce({
        id: 'ch_1',
        status: 'authorized_pending_capture',
        amount: 20000,
      });
      mockPagarme.delete.mockResolvedValueOnce({});
      service = await build();

      const r = await service.liberarRetencao('ch_1');

      expect(r.acao).toBe('liberada');
      expect(mockPagarme.delete).toHaveBeenCalledWith('/charges/ch_1');
      expect(r.detalhe).toContain('200.00');
    });

    /**
     * A salvaguarda principal. Na Pagar.me o mesmo DELETE que cancela uma
     * cobrança autorizada vira ESTORNO numa cobrança paga: um id trocado
     * desfaria a venda e devolveria o dinheiro do vendedor.
     */
    it('RECUSA cancelar uma cobrança PAGA — seria um estorno', async () => {
      mockPagarme.get.mockResolvedValueOnce({
        id: 'ch_pago',
        status: 'paid',
        amount: 20000,
      });
      service = await build();

      const r = await service.liberarRetencao('ch_pago');

      expect(r.acao).toBe('nao-e-retencao');
      expect(mockPagarme.delete).not.toHaveBeenCalled();
    });

    it('não cancela nada quando a consulta falha (fail-closed)', async () => {
      mockPagarme.get.mockRejectedValueOnce(new Error('502'));
      service = await build();

      const r = await service.liberarRetencao('ch_1');

      expect(r.acao).toBe('erro-consulta');
      expect(mockPagarme.delete).not.toHaveBeenCalled();
    });

    it('reporta a falha do cancelamento em vez de fingir sucesso', async () => {
      mockPagarme.get.mockResolvedValueOnce({
        id: 'ch_1',
        status: 'authorized_pending_capture',
        amount: 20000,
      });
      mockPagarme.delete.mockRejectedValueOnce({
        response: { pagarme: { message: 'Charge cannot be canceled' } },
      });
      service = await build();

      const r = await service.liberarRetencao('ch_1');

      expect(r.acao).toBe('erro-cancelamento');
      expect(r.detalhe).toBe('Charge cannot be canceled');
    });
  });
});
