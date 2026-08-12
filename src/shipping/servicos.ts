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
  // ── Jadlog: fora da plataforma desde 12/08/2026 ────────────────────────────
  // Ela RECUSA envio não-comercial (sem nota fiscal) partindo de alguns estados,
  // e todo envio da Kolecta é assim — `non_commercial: true` fixo no carrinho,
  // porque quem vende aqui é pessoa física.
  //
  // O veneno é que a recusa NÃO aparece na cotação: conferido contra a API de
  // produção em 12/08, o `/shipment/calculate` devolve a Jadlog com preço e
  // prazo normais (com ou sem `options.non_commercial`), e só o `/cart` responde
  // "Esta transportadora não aceita envios não-comerciais partindo deste
  // estado". Ou seja: o comprador escolhe, paga, e a etiqueta é impossível.
  //
  // Aconteceu no pedido 0c57df5a (Foz do Iguaçu/PR → Londrina/PR, 11/08): frete
  // pago, etiqueta `failed`, nada postado. Placar da Jadlog em produção: 1
  // tentativa, 1 falha.
  //
  // Volta ao ar quando o Melhor Envio disser em QUAIS estados a regra vale (aí
  // vira restrição por UF de origem) ou quando emitirmos com nota fiscal.
  {
    id: 3,
    transportadora: 'Jadlog',
    nome: '.Package',
    nacional: false,
    aviso:
      'Recusa envio sem nota fiscal partindo de alguns estados (o PR é um ' +
      'deles) — e a recusa só aparece na hora de emitir a etiqueta.',
  },
  {
    id: 4,
    transportadora: 'Jadlog',
    nome: '.Com',
    nacional: false,
    aviso:
      'Recusa envio sem nota fiscal partindo de alguns estados (o PR é um ' +
      'deles) — e a recusa só aparece na hora de emitir a etiqueta.',
  },
  {
    id: 27,
    transportadora: 'Jadlog',
    nome: '.Package Centralizado',
    nacional: false,
    aviso:
      'Recusa envio sem nota fiscal partindo de alguns estados (o PR é um ' +
      'deles) — e a recusa só aparece na hora de emitir a etiqueta.',
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

/**
 * Serviços que EXIGEM nota fiscal, de `GET /me/shipment/services` →
 * `requirements` (conferido em 12/08/2026 na conta de produção).
 *
 * Todo envio da Kolecta vai `non_commercial: true`, sem nota — então estes são
 * impossíveis para nós, e mostrá-los na cotação é vender um frete que não vira
 * etiqueta. Não tem a ver com o vendedor ser PF ou PJ: a Rock Wheels tem CNPJ e
 * a Jadlog recusou do mesmo jeito, porque quem não tem nota é o ENVIO.
 *
 * É a lista de reserva: o normal é ler `requirements` da API, que se atualiza
 * sozinha se uma transportadora mudar de regra. Isto aqui é o que vale quando a
 * chamada falha — a cotação não pode cair junto.
 */
export const EXIGEM_NOTA_FISCAL: readonly number[] = [3, 4, 12, 15, 16, 22, 27];

/**
 * Este serviço exige nota fiscal? Lê o `requirements` como o Melhor Envio o
 * devolve, que vem em DUAS formas:
 *
 * - lista de rótulos: `["names","addresses","documents","invoice"]`;
 * - objeto de regras estilo Laravel (a Total Express é assim hoje), em que a
 *   nota aparece como `options.invoice.key: ["required_if:options.non_commercial,false"]`
 *   — ou seja, obrigatória só quando o envio se declara COMERCIAL. Para nós,
 *   que declaramos o contrário, não é exigência nenhuma.
 *
 * Ler só a primeira forma trataria a segunda como "não exige" por acidente. Aqui
 * é por decisão, e a diferença está escrita.
 */
export function exigeNotaFiscal(requirements: unknown): boolean {
  if (Array.isArray(requirements)) {
    return requirements.some((r) => String(r).toLowerCase() === 'invoice');
  }
  const regras = (requirements as any)?.rules;
  if (!regras || typeof regras !== 'object') return false;
  return Object.entries(regras).some(([campo, condicoes]) => {
    if (!campo.includes('invoice')) return false;
    const lista = Array.isArray(condicoes) ? condicoes.map(String) : [];
    // `required` seco exige sempre; `required_if:options.non_commercial,false`
    // só exige de quem manda nota — que não é o nosso caso.
    return lista.includes('required');
  });
}

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
 *
 * O padrão perdeu a Jadlog (id 3) em 12/08/2026 — o motivo está no catálogo,
 * junto da entrada dela. O padrão é o que vale para os 218 vendedores que nunca
 * abriram as configurações de envio, então tirar daqui é o que realmente
 * desliga a transportadora.
 */
export function servicosDaPlataforma(): number[] {
  return (
    parseServicos(process.env.MELHOR_ENVIO_SERVICOS ?? '1,2,17,31,33') ?? []
  );
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
