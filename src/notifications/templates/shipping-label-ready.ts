// E-mail — "Sua etiqueta de envio está pronta" (para o VENDEDOR / remetente)
// Gatilho: evento `shipping.label.ready`, disparado quando a Kolecta emite a
// etiqueta no Melhor Envio (compra direta ou arremate de leilão).
//
// O PDF vai ANEXADO: o vendedor não precisa de conta no Melhor Envio nem de
// acesso ao painel da Kolecta — é só imprimir, colar e postar. O link fica
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
   * Página do pedido no painel da Kolecta — NÃO a URL do Melhor Envio.
   *
   * A do ME é página de painel protegida por sessão: quem clicava caía no login
   * de uma conta que não é dele (aconteceu em 31/07). O download do arquivo
   * exige a nossa autenticação, e link de e-mail não carrega token — por isso o
   * botão leva ao painel, onde o vendedor já está logado.
   */
  labelUrl?: string | null;
  /** true quando o anexo não pôde ser baixado e só resta o link. */
  semAnexo?: boolean;
}

const TITLE = 'Sua etiqueta de envio está pronta';

const paragraphs = (data: ShippingLabelReadyData) => [
  `${esc(firstName(data.sellerName))}, sua venda de <strong>${esc(
    data.listingTitle,
  )}</strong> foi paga e a Kolecta já comprou a etiqueta de envio para você.`,
  data.semAnexo
    ? 'Baixe a etiqueta pelo botão abaixo, imprima e cole na embalagem.'
    : 'A etiqueta está <strong>anexada neste e-mail</strong> em PDF. É só imprimir, colar na embalagem e postar.',
];

export function subject(data: ShippingLabelReadyData): string {
  return `Etiqueta pronta — poste o pedido ${data.orderId.slice(0, 8)}`;
}

export function html(data: ShippingLabelReadyData): string {
  return renderEmail({
    preheader: data.semAnexo
      ? 'Baixe, imprima e poste — a Kolecta já pagou o frete.'
      : 'O PDF está anexado. Imprima, cole e poste — a Kolecta já pagou o frete.',
    tag: 'Hora de postar',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks:
      dataBox({
        title: `Pedido ${data.orderId}`,
        rows: [
          ['Item', data.listingTitle],
          ['Comprador', data.buyerName || '—'],
          ['Destino', data.buyerCity || '—'],
          ['Transportadora', data.carrier || '—'],
          ['Serviço', data.service || '—'],
          ['Rastreio', data.trackingCode || 'Disponível após a postagem'],
        ],
      }) +
      checklistBox({
        title: 'Antes de postar',
        items: [
          'Embale bem: item frágil quebra e vira disputa.',
          'Cole a etiqueta inteira e legível, sem fita por cima do código de barras.',
          'Poste em até 2 dias úteis — o comprador acompanha o prazo.',
          'Marque o pedido como enviado no painel para liberar o rastreio ao comprador.',
        ],
      }),
    cta: data.labelUrl
      ? { href: data.labelUrl, label: 'Baixar etiqueta no painel' }
      : undefined,
    ctaCaption:
      'O frete já foi pago pela Kolecta — você não precisa desembolsar nada na postagem.',
  });
}

export function text(data: ShippingLabelReadyData): string {
  return renderText({
    title: TITLE,
    paragraphs: [
      `${firstName(data.sellerName)}, sua venda de "${data.listingTitle}" foi paga e a Kolecta já comprou a etiqueta.`,
      data.semAnexo
        ? 'Baixe a etiqueta pelo link abaixo, imprima e poste.'
        : 'A etiqueta está anexada neste e-mail em PDF. Imprima, cole e poste.',
    ],
    lines: [
      `Pedido: ${data.orderId}`,
      `Item: ${data.listingTitle}`,
      `Comprador: ${data.buyerName || '—'}`,
      `Destino: ${data.buyerCity || '—'}`,
      `Transportadora: ${data.carrier || '—'} ${data.service || ''}`.trim(),
      `Rastreio: ${data.trackingCode || 'disponível após a postagem'}`,
      'O frete já foi pago pela Kolecta.',
    ],
    cta: data.labelUrl
      ? { href: data.labelUrl, label: 'Baixar etiqueta no painel' }
      : undefined,
  });
}
