// Normalização de marca, linha e escala na ESCRITA.
//
// Existia só no front (src/lib/marcas.ts), e só os formulários de criação e de
// edição chamavam. A importação por planilha gravava cru: é o único caminho de
// escrita que passava por fora, apesar de o comentário lá dizer que "todo
// caminho converge".
//
// O que o banco mostra hoje (05/08/2026, anúncios ativos) é pequeno e vale
// registrar com honestidade, para ninguém superestimar o problema depois:
//
//     cards-colecionaveis: "COPAG" (3), "Copag" (3), "Copag " (1)
//     action-figures:      "MATTEL" (1), "Mattel" (1)
//
// A vitrine NÃO está rachada por causa disso: a prateleira de cards é o jogo,
// não a marca, e a de action figures compara por chave normalizada, então
// MATTEL e Mattel caem no mesmo grupo. O estrago real hoje é só de exibição na
// página do anúncio, mais um espaço sobrando em "Copag ".
//
// O motivo de fazer isto AGORA é o que vem: a importação do Bling vai trazer
// marca digitada por cada lojista no ERP dele, onde ninguém curou grafia. É lá
// que escrita sem normalização vira problema de verdade, e é melhor a trava já
// estar no lugar antes do primeiro lote de 500 produtos.
//
// O QUE NAO FOI PORTADO, de propósito: os apelidos ("Hotwheels" para "Hot
// Wheels") e a detecção de montadora no lugar do fabricante (Ferrari, Nissan).
// Essa parte é grande, vive no front porque é lá que o vendedor digita e pode
// ser corrigido na hora, e o banco não mostra nenhum caso desses hoje.
//
// Marca fora da lista canônica NÃO tem a caixa forçada: "MSZ", "CCA", "IXO
// Models" e "SHOOM64" são grafias legítimas, e title case as estragaria.

/** Marcas canônicas, extraídas de MARCAS_MINIATURA do front. */
const MARCAS_CANONICAS = [
  "Hot Wheels",
  "Mini GT",
  "Matchbox",
  "Tarmac Works",
  "Kaido House",
  "Pop Race",
  "Inno64",
  "M2 Machines",
  "Bburago",
  "Majorette",
  "Tomica",
  "Maisto",
  "Greenlight",
  "Johnny Lightning",
  "Solido",
  "Auto World",
  "Robert Design",
  "MSZ",
  "Time Micro",
  "Minichamps",
  "Jada Toys",
  "Welly",
  "Schuco",
  "Spark",
  "Norev",
  "IXO Models",
  "UT Models",
  "BBR Models",
  "Star Model",
  "MyModelCollect",
  "Mac Tools",
  "Fast & Speed",
  "CCA",
  "D'Agostini",
  "AUTOart",
  "Kyosho",
  "Era Car",
  "Stance Hunters",
  "Motorhelix",
  "GCD",
  "Storehouse Custom",
  "SHOOM64",
  "CKS",
  "D Model",
  "Cool Car",
  "MoreArt",
  "BR Classics",
  "Carros Inesquecíveis",
  "Outra",
] as const;

/** Escalas canônicas, extraídas de ESCALAS_MINIATURA do front. */
const ESCALAS_CANONICAS = ["1:64", "1:43", "1:41", "1:32", "1:24", "1:18", "1:12", "Outra"] as const;

/** Minúsculas, sem acento e sem pontuação: "Hot Wheels" e "hot-wheels" batem. */
function chave(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const POR_CHAVE = new Map(MARCAS_CANONICAS.map((m) => [chave(m), m as string]));

/**
 * Marca pronta para gravar.
 *
 * Marca fora da lista é PRESERVADA aparada, nunca descartada: marca pequena de
 * verdade é informação, e apagá-la seria pior do que a grafia torta.
 */
export function normalizarMarca(bruto: string | null | undefined): string | null {
  const texto = String(bruto ?? '').replace(/\s+/g, ' ').trim();
  if (!texto) return null;
  return POR_CHAVE.get(chave(texto)) ?? texto;
}

/** Escala pronta para gravar. Aceita "1/64" e "1-64", que aparecem no banco. */
export function normalizarEscala(bruto: string | null | undefined): string | null {
  const texto = String(bruto ?? '').trim();
  if (!texto) return null;
  const padrao = texto.replace(/\s+/g, '').replace(/[/-]/g, ':');
  const achou = ESCALAS_CANONICAS.find((e) => e === padrao);
  if (achou) return achou;
  return chave(texto) === 'outra' ? 'Outra' : texto;
}

/**
 * Linha pronta para gravar.
 *
 * Só aparo e espaço colapsado. A regra rica do front (que usa a marca para
 * decidir a linha) não foi portada: depende do catálogo de linhas por marca,
 * que é outro arquivo grande, e o dano observado no banco é de espaço, não de
 * conteúdo.
 */
export function normalizarLinha(bruto: string | null | undefined): string | null {
  const texto = String(bruto ?? '').replace(/\s+/g, ' ').trim();
  return texto || null;
}
