// E-mail: "Sua etiqueta de envio está pronta" (para o VENDEDOR / remetente)
// Gatilho: evento `shipping.label.ready`, disparado quando a Kolecta emite a
// etiqueta no Melhor Envio (compra direta ou arremate de leilão).
//
// O PDF vai ANEXADO: o vendedor não precisa de conta no Melhor Envio nem de
// acesso ao painel da Kolecta, é só imprimir, colar e postar. O link fica
// como alternativa, mas ele expira; o anexo não.
import {
  renderEmail,
  renderText,
  dataBox,
  checklistBox,
  esc,
  firstName,
} from './layout';

export interface ShippingLabelReadyData {
  sellerName: string | null;
  orderId: string;
  listingTitle: string;
  buyerName?: string | null;
  buyerCity?: string | null;
  carrier?: string | null;
  service?: string | null;
  trackingCode?: string | null;
  /**
   * Página do pedido no painel da Kolecta, e NÃO a URL do Melhor Envio.
   *
   * A do ME é página de painel protegida por sessão: quem clicava caía no login
   * de uma conta que não é dele (aconteceu em 31/07). O download do arquivo
   * exige a nossa autenticação, e link de e-mail não carrega token, por isso o
   * botão leva ao painel, onde o vendedor já está logado.
   */
  labelUrl?: string | null;
  /** true quando o anexo não pôde ser baixado e só resta o link. */
  semAnexo?: boolean;
  /**
   * true quando o anexo traz etiqueta E declaração de conteúdo na mesma folha.
   *
   * A declaração é obrigatória para postar sem nota fiscal, que é o caso de todo
   * envio da Kolecta. Ela sempre existiu no Melhor Envio; o e-mail é que anexava
   * só a etiqueta, e quem descobria a falta era o vendedor no balcão.
   *
   * false quando a DC-e ainda não tinha saído na hora do envio (ela é
   * assíncrona). Aí o texto manda buscar no painel em vez de prometer o que não
   * está anexado.
   */
  comDeclaracao?: boolean;
}

const TITLE = 'Sua etiqueta de envio está pronta';

const paragraphs = (data: ShippingLabelReadyData) => [
  `${esc(firstName(data.sellerName))}, sua venda de <strong>${esc(
    data.listingTitle,
  )}</strong> foi paga e a Kolecta já comprou a etiqueta de envio para você.`,
  data.semAnexo
    ? 'Baixe a etiqueta pelo botão abaixo, imprima e cole na embalagem.'
    : data.comDeclaracao
      ? 'O PDF <strong>anexado neste e-mail</strong> traz a etiqueta e a declaração de conteúdo na mesma folha. Imprima, recorte, cole a etiqueta na caixa e leve a declaração junto.'
      : 'A etiqueta está <strong>anexada neste e-mail</strong> em PDF. A declaração de conteúdo ainda estava sendo emitida: baixe-a no painel antes de postar.',
];

export function subject(data: ShippingLabelReadyData): string {
  return `Etiqueta pronta: poste o pedido ${data.orderId.slice(0, 8)}`;
}

export function html(data: ShippingLabelReadyData): string {
  return renderEmail({
    preheader: data.semAnexo
      ? 'Baixe, imprima e poste. A Kolecta já pagou o frete.'
      : 'O PDF está anexado. Imprima, cole e poste: a Kolecta já pagou o frete.',
    tag: 'Hora de postar',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks:
      dataBox({
        title: `Pedido ${data.orderId}`,
        rows: [
          ['Item', data.listingTitle],
          ['Comprador', data.buyerName || 'não informado'],
          ['Destino', data.buyerCity || 'não informado'],
          ['Transportadora', data.carrier || 'não informada'],
          ['Serviço', data.service || 'não informado'],
          ['Rastreio', data.trackingCode || 'Disponível após a postagem'],
        ],
      }) +
      checklistBox({
        title: 'Antes de postar',
        items: [
          'Embale bem: item frágil quebra e vira disputa.',
          'Cole a etiqueta inteira e legível, sem fita por cima do código de barras.',
          // A declaração de conteúdo é o documento que os Correios cobram no
          // balcão de quem posta sem nota fiscal. Sem ela na mão, o atendente
          // recusa a postagem e o vendedor volta para casa.
          data.comDeclaracao
            ? 'Leve a declaração de conteúdo junto: é a segunda parte da folha, e os Correios pedem no balcão.'
            : 'Baixe a declaração de conteúdo no painel e leve junto: os Correios pedem no balcão.',
          'Poste em até 2 dias úteis. O comprador acompanha o prazo.',
          'Marque o pedido como enviado no painel para liberar o rastreio ao comprador.',
        ],
      }),
    cta: data.labelUrl
      ? { href: data.labelUrl, label: 'Ver o pedido no painel' }
      : undefined,
    ctaCaption:
      'O frete já foi pago pela Kolecta. Você não precisa desembolsar nada na postagem.',
  });
}

export function text(data: ShippingLabelReadyData): string {
  return renderText({
    title: TITLE,
    paragraphs: [
      `${firstName(data.sellerName)}, sua venda de "${data.listingTitle}" foi paga e a Kolecta já comprou a etiqueta.`,
      data.semAnexo
        ? 'Baixe a etiqueta pelo link abaixo, imprima e poste.'
        : data.comDeclaracao
          ? 'O PDF anexado traz a etiqueta e a declaração de conteúdo na mesma folha. Imprima, cole a etiqueta na caixa e leve a declaração junto.'
          : 'A etiqueta está anexada neste e-mail em PDF. A declaração de conteúdo ainda estava sendo emitida: baixe no painel antes de postar.',
    ],
    lines: [
      `Pedido: ${data.orderId}`,
      `Item: ${data.listingTitle}`,
      `Comprador: ${data.buyerName || 'não informado'}`,
      `Destino: ${data.buyerCity || 'não informado'}`,
      `Transportadora: ${data.carrier || 'não informada'} ${data.service || ''}`.trim(),
      `Rastreio: ${data.trackingCode || 'disponível após a postagem'}`,
      'A declaração de conteúdo é obrigatória para postar sem nota fiscal.',
      'O frete já foi pago pela Kolecta.',
    ],
    cta: data.labelUrl
      ? { href: data.labelUrl, label: 'Ver o pedido no painel' }
      : undefined,
  });
}
