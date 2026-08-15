// E-mail — "A transportadora do seu pedido mudou" (para o COMPRADOR)
// Gatilho: evento `shipping.carrier.changed`, quando a transportadora escolhida
// no checkout recusa o envio na hora de emitir a etiqueta e a Kolecta emite por
// outra.
//
// Existe porque o comprador escolheu e pagou um serviço específico: descobrir
// pelo rastreio que o pacote veio por outra empresa parece erro nosso — ou
// golpe. O e-mail chega ANTES da postagem, dizendo o que mudou, que não custa
// nada a mais e que o prazo pode mexer.
//
// O motivo técnico do Melhor Envio NÃO vai aqui de propósito ("não aceita
// envios não-comerciais partindo deste estado" não significa nada para quem
// comprou um carrinho de coleção). Vai a versão em português de gente.
import {
  renderEmail,
  renderText,
  dataBox,
  BRAND,
  esc,
  firstName,
} from './layout';

export interface ShippingCarrierChangedData {
  buyerName: string | null;
  orderId: string;
  listingTitle: string;
  /** Transportadora que ele escolheu no checkout. */
  de: string;
  /** A que vai levar o pacote. */
  para: string;
}

const TITLE = 'A transportadora do seu pedido mudou';

const cta = (orderId: string) => ({
  href: `${BRAND.site}/conta/pedidos/${orderId}`,
  label: 'Ver meu pedido',
});

const paragraphs = (data: ShippingCarrierChangedData) => [
  `${esc(firstName(data.buyerName))}, a <strong>${esc(data.de)}</strong> não pôde levar o seu pedido saindo da cidade do vendedor, então a Kolecta emitiu a etiqueta pela <strong>${esc(data.para)}</strong>.`,
  'Você <strong>não paga nada a mais</strong> por isso — a diferença, se houver, é por nossa conta. O prazo de entrega pode mudar um pouco, e o código de rastreio chega assim que o vendedor postar.',
];

export function subject(data: ShippingCarrierChangedData): string {
  return `Seu pedido ${data.orderId.slice(0, 8)} vai por outra transportadora`;
}

export function html(data: ShippingCarrierChangedData): string {
  return renderEmail({
    preheader: `Agora vai pela ${data.para}. Sem custo adicional para você.`,
    tag: 'Mudança no envio',
    title: TITLE,
    paragraphs: paragraphs(data),
    blocks: dataBox({
      title: `Pedido ${data.orderId}`,
      rows: [
        ['Item', data.listingTitle],
        ['Antes', data.de],
        ['Agora', data.para],
        ['Custo extra para você', 'Nenhum'],
      ],
    }),
    cta: cta(data.orderId),
    ctaCaption: `Qualquer dúvida, é só responder este e-mail ou falar com a gente em ${BRAND.support}.`,
  });
}

export function text(data: ShippingCarrierChangedData): string {
  return renderText({
    title: TITLE,
    paragraphs: paragraphs(data),
    lines: [
      `Pedido: ${data.orderId}`,
      `Item: ${data.listingTitle}`,
      `Antes: ${data.de}`,
      `Agora: ${data.para}`,
      'Custo extra para você: nenhum',
    ],
    cta: cta(data.orderId),
  });
}
