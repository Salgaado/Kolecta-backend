/**
 * O link do e-mail de etiqueta.
 *
 * Já quebrou duas vezes pelo mesmo motivo: mandar ao vendedor a URL do
 * `/shipment/print` do Melhor Envio. Aquilo não é arquivo, é página de painel
 * protegida por sessão — quem clica cai no login de uma conta que não é dele, e
 * mesmo com conta própria não acharia o envio, porque ele pertence à conta da
 * Kolecta.
 *
 * Em 25/07/2026 o botão do PAINEL foi corrigido para passar pelo nosso
 * endpoint. O e-mail ficou para trás e derrubou a primeira venda real da conta
 * nova em 31/07. Este teste existe para não haver terceira vez.
 */
import { ShippingLabelListener } from './shipping-label.listener';

describe('e-mail da etiqueta — o link nunca aponta para o Melhor Envio', () => {
  const orderId = '99e99de1-b45e-4a45-a2fc-9185f7835bbc';
  let mail: any;
  let listener: any;

  const fazerDb = () => {
    const db: any = {
      query: {
        orders: {
          findFirst: jest.fn().mockResolvedValue({
            id: orderId,
            sellerId: 'seller-1',
            buyerId: 'buyer-1',
            listingId: 'lst-1',
            addressId: 'addr-1',
            shippingServiceName: 'Correios SEDEX',
            trackingCode: null,
          }),
        },
        addresses: {
          findFirst: jest.fn().mockResolvedValue({ city: 'Rio', state: 'RJ' }),
        },
        listings: {
          findFirst: jest.fn().mockResolvedValue({ title: 'Hot Wheels RLC' }),
        },
      },
    };
    db.select = jest.fn().mockReturnValue(db);
    db.from = jest.fn().mockReturnValue(db);
    // 1ª = vendedor, 2ª = comprador.
    db.where = jest
      .fn()
      .mockResolvedValueOnce([{ name: 'Raquel', email: 'v@x.com' }])
      .mockResolvedValueOnce([{ name: 'Comprador' }]);
    return db;
  };

  beforeEach(() => {
    mail = { send: jest.fn().mockResolvedValue(undefined) };
    const shipping: any = {
      // Cenário do incidente: o Melhor Envio ainda não gerou o arquivo, então
      // o e-mail sai SEM anexo e só resta o link — que é o que quebrou.
      obterPdfDaEtiqueta: jest
        .fn()
        .mockRejectedValue(
          new Error('O Melhor Envio ainda não disponibilizou o arquivo.'),
        ),
    };
    listener = new ShippingLabelListener(
      shipping,
      mail,
      { get: jest.fn() } as any,
      fazerDb(),
    );
  });

  const enviar = () =>
    listener.aoFicarPronta({
      orderId,
      // Mesmo recebendo a URL do ME no evento, ela NÃO pode ir para o e-mail.
      labelUrl: 'https://melhorenvio.com.br/shipment/print/abc123',
    });

  it('não manda nenhuma URL do Melhor Envio para o vendedor', async () => {
    await enviar();

    const enviado = JSON.stringify(mail.send.mock.calls[0][0]);
    expect(enviado).not.toContain('melhorenvio');
  });

  it('aponta para a página do pedido no painel da Kolecta', async () => {
    await enviar();

    const { data } = mail.send.mock.calls[0][0];
    expect(data.labelUrl).toContain('/painel/pedidos/' + orderId);
    expect(data.labelUrl).toMatch(/^https:\/\/kolecta\.com\.br/);
  });

  it('avisa no corpo que o anexo não veio, para o link fazer sentido', async () => {
    await enviar();

    const { data, attachments } = mail.send.mock.calls[0][0];
    expect(data.semAnexo).toBe(true);
    expect(attachments).toBeUndefined();
  });
});
