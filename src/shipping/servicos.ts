// Catálogo de serviços de envio e as regras de quem pode oferecer o quê.
//
// Estava tudo dentro do ShippingService: uma constante privada com os ids
// permitidos e um mapa de nomes que só servia para o log. Virou arquivo próprio
// quando o VENDEDOR passou a escolher com quais transportadoras trabalha, porque
// agora três lugares precisam da mesma verdade: a cotação (filtra), o perfil do
// vendedor (mostra as opções) e a validação (recusa uma seleção que deixaria
// regiões sem frete).
//
// Os ids vêm de `GET /me/shipment/services` na conta de produção (conferido em
// 05/08/2026, 15 serviços habilitados).

export interface ServicoEnvio {
  id: number;
  transportadora: string;
  nome: string;
  /**
   * Atende o país inteiro. Só os Correios têm isso de verdade; as demais são
   * regionais em graus diferentes. É o que sustenta a regra de seleção mínima
   * lá embaixo.
   */
  nacional: boolean;
  /** O que o vendedor precisa saber ANTES de marcar. Vai direto para a tela. */
  aviso?: string;
}

/**
 * Tudo que a conta da Kolecta consegue emitir hoje.
 *
 * Ter o catálogo completo, e não só os seis liberados, é de propósito: se o
 * `MELHOR_ENVIO_SERVICOS` mudar, a tela do vendedor continua sabendo o nome e a
 * limitação de cada um sem precisar de deploy do front.
 */
export const CATALOGO_SERVICOS: readonly ServicoEnvio[] = [
  { id: 1, transportadora: 'Correios', nome: 'PAC', nacional: true },
  { id: 2, transportadora: 'Correios', nome: 'SEDEX', nacional: true },
  {
    id: 17,
    transportadora: 'Correios',
    nome: 'Mini Envios',
    nacional: true,
    aviso: 'Só aceita pacotes de até 300 g e 16×11×3 cm.',
  },
  {
    id: 3,
    transportadora: 'Jadlog',
    nome: '.Package',
    nacional: false,
    aviso: 'Postagem em agência Jadlog. Cobertura menor no Norte.',
  },
  {
    id: 4,
    transportadora: 'Jadlog',
    nome: '.Com',
    nacional: false,
    aviso: 'Postagem em agência Jadlog. Cobertura menor no Norte.',
  },
  {
    id: 27,
    transportadora: 'Jadlog',
    nome: '.Package Centralizado',
    nacional: false,
    aviso: 'Postagem em agência Jadlog. Cobertura menor no Norte.',
  },
  {
    id: 31,
    transportadora: 'Loggi',
    nome: 'Express',
    nacional: false,
    aviso: 'Cobertura regional, concentrada nas capitais.',
  },
  {
    id: 32,
    transportadora: 'Loggi',
    nome: 'Coleta',
    nacional: false,
    aviso: 'A Loggi busca o pacote no seu endereço. Cobertura regional.',
  },
  {
    id: 34,
    transportadora: 'Loggi',
    nome: 'Loggi Ponto',
    nacional: false,
    aviso: 'Você deixa o pacote num ponto Loggi. Cobertura regional.',
  },
  {
    id: 33,
    transportadora: 'JeT',
    nome: 'Standard',
    nacional: false,
    aviso: 'Cobertura regional. Exige telefone do remetente na etiqueta.',
  },
  {
    id: 35,
    transportadora: 'Total Express',
    nome: 'Standard',
    nacional: false,
    aviso: 'Cobertura regional.',
  },
  // Estes três exigem `agency` (id da agência) no carrinho do Melhor Envio, que
  // a Kolecta não coleta em lugar nenhum. Ficam no catálogo para o nome aparecer
  // certo num log ou num pedido antigo, mas não devem entrar no
  // MELHOR_ENVIO_SERVICOS sem antes existir a escolha de agência.
  {
    id: 12,
    transportadora: 'LATAM Cargo',
    nome: 'éFácil',
    nacional: false,
    aviso: 'Exige escolher a agência de postagem (ainda não suportado).',
  },
  {
    id: 15,
    transportadora: 'Azul Cargo Express',
    nome: 'Expresso',
    nacional: false,
    aviso: 'Exige escolher a agência de postagem (ainda não suportado).',
  },
  {
    id: 16,
    transportadora: 'Azul Cargo Express',
    nome: 'e-commerce',
    nacional: false,
    aviso: 'Exige escolher a agência de postagem (ainda não suportado).',
  },
  {
    id: 22,
    transportadora: 'Buslog',
    nome: 'Rodoviário',
    nacional: false,
    aviso: 'Exige escolher a agência de postagem (ainda não suportado).',
  },
];

const POR_ID = new Map(CATALOGO_SERVICOS.map((s) => [s.id, s]));

export function servicoPorId(id: number): ServicoEnvio | undefined {
  return POR_ID.get(id);
}

/** "Correios PAC", para log e para tela. */
export function nomeDoServico(id: number): string {
  const s = POR_ID.get(id);
  return s ? `${s.transportadora} ${s.nome}` : `serviço ${id}`;
}

/**
 * O que a PLATAFORMA libera, de `MELHOR_ENVIO_SERVICOS`.
 *
 * Vazio (`MELHOR_ENVIO_SERVICOS=`) desliga o corte e volta a mostrar tudo que a
 * conta habilita. É a saída rápida se o filtro deixar alguma região sem opção.
 */
export function servicosDaPlataforma(): number[] {
  return parseServicos(process.env.MELHOR_ENVIO_SERVICOS ?? '1,2,3,17,31,33') ?? [];
}

/** CSV de ids ("1,2,17") → lista de números. `null` quando não há nada gravado. */
export function parseServicos(csv: string | null | undefined): number[] | null {
  if (csv === null || csv === undefined) return null;
  const ids = String(csv)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return ids;
}

/** Lista de ids → CSV para gravar. Lista vazia vira `null` (= usa o padrão). */
export function serializarServicos(ids: number[] | null): string | null {
  if (!ids || ids.length === 0) return null;
  return [...new Set(ids)].sort((a, b) => a - b).join(',');
}

/**
 * O que ESTE vendedor oferece: interseção entre o que a plataforma libera e o
 * que ele escolheu.
 *
 * Interseção, e não substituição: um vendedor que marcou Jadlog antes de a
 * plataforma cortar a Jadlog não pode continuar vendendo nela. A palavra final é
 * sempre da plataforma.
 *
 * Vendedor sem escolha (`null`, que é o estado de todo mundo hoje) recebe o
 * conjunto da plataforma inteiro, o comportamento de antes, sem mudança.
 */
export function servicosDoVendedor(
  daPlataforma: number[],
  doVendedor: number[] | null,
): number[] {
  if (!doVendedor || doVendedor.length === 0) return daPlataforma;
  if (daPlataforma.length === 0) return doVendedor;
  const permitidos = new Set(daPlataforma);
  const cruzados = doVendedor.filter((id) => permitidos.has(id));
  // Interseção vazia significa que a plataforma cortou tudo que ele tinha
  // marcado. Voltar ao conjunto da plataforma é melhor do que deixar a loja dele
  // sem frete nenhum até ele reabrir as configurações.
  return cruzados.length > 0 ? cruzados : daPlataforma;
}

/**
 * Pelo menos um serviço que atende o país inteiro.
 *
 * Mini Envios não conta: ele é nacional mas trava em 300 g, então uma seleção
 * "só Mini Envios" deixa sem frete qualquer pacote acima disso, que é a maioria
 * do que se vende aqui.
 *
 * Sem esta regra, o vendedor que marcasse só a transportadora da esquina perdia
 * silenciosamente toda venda fora da região dela: o comprador simplesmente não
 * via frete e ia embora, e ninguém dos dois lados descobria por quê.
 */
export function temCoberturaNacional(ids: number[]): boolean {
  return ids.some((id) => {
    const s = POR_ID.get(id);
    return !!s?.nacional && !s.aviso;
  });
}

/** Serviços com cobertura nacional que a plataforma libera hoje, por nome. */
export function nomesComCoberturaNacional(daPlataforma: number[]): string[] {
  return daPlataforma
    .filter((id) => {
      const s = POR_ID.get(id);
      return !!s?.nacional && !s.aviso;
    })
    .map(nomeDoServico);
}
