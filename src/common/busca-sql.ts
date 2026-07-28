/**
 * Busca por texto em SQL, ignorando acento e caixa.
 *
 * Espelha `src/lib/busca.ts` do frontend, que hoje faz este trabalho no
 * navegador sobre o catálogo inteiro baixado. A comparação crua do SQLite
 * (`LIKE '%pokemon%'`) não acha "Pokémon", e é assim que a maioria digita.
 *
 * O SQLite não tem `unaccent`, e o `lower()` dele só entende ASCII — 'Á' não
 * vira 'á'. A saída é uma cadeia de `replace`, mas ela não pode ser funda: o
 * parser estoura ("parser stack overflow") entre 24 e 29 chamadas aninhadas, e
 * cobrir as duas caixas de cada acento numa cadeia só passa disso. Por isso o
 * alvo é montado em DUAS versões rasas (~15 níveis cada), uma tratando os
 * acentos minúsculos e outra os maiúsculos, e cada palavra procurada casa em
 * qualquer uma das duas. Só escaparia uma palavra que misturasse acento
 * maiúsculo e minúsculo dentro de si ("AÇão"), que não existe na prática.
 *
 * Custo: a varredura roda os `replace` linha a linha, sem índice — `LIKE` com
 * curinga à esquerda não usa índice de qualquer forma. Serve com folga para o
 * catálogo atual; quando pesar, o caminho é uma coluna `search_text` já
 * normalizada na escrita.
 */

import { sql, SQL, SQLWrapper } from 'drizzle-orm';

/** Acentuado → letra simples. Português, mais os estrangeiros comuns. */
const ACENTOS: ReadonlyArray<readonly [string, string]> = [
  ['á', 'a'],
  ['à', 'a'],
  ['â', 'a'],
  ['ã', 'a'],
  ['ä', 'a'],
  ['é', 'e'],
  ['ê', 'e'],
  ['í', 'i'],
  ['ó', 'o'],
  ['ô', 'o'],
  ['õ', 'o'],
  ['ö', 'o'],
  ['ú', 'u'],
  ['ü', 'u'],
  ['ç', 'c'],
  ['ñ', 'n'],
];

/** Máximo de palavras consideradas — evita SQL gigante em termo colado. */
const MAX_PALAVRAS = 6;

/** As duas leituras normalizadas do mesmo texto. Ver o cabeçalho do arquivo. */
export interface AlvoDeBusca {
  /** Trata os acentos minúsculos ("Pokémon", "coleção"). */
  minusculos: SQL<string>;
  /** Trata os acentos maiúsculos ("MANGÁ", "EDIÇÃO"). */
  maiusculos: SQL<string>;
}

/**
 * Uma passada de `replace` por par, com o mapa entrando como literal
 * (`sql.raw`) e não como parâmetro: são dezenas de pares, e ligados dariam
 * quase cem bind params por termo de busca. Seguro porque o mapa é fixo no
 * código; o que vem do usuário continua parametrizado.
 */
function normalizarSql(
  expr: SQLWrapper | SQL,
  pares: ReadonlyArray<readonly [string, string]>,
): SQL<string> {
  let out: SQL = sql`${expr}`;
  for (const [de, para] of pares) {
    out = sql`replace(${out}, ${sql.raw(`'${de}'`)}, ${sql.raw(`'${para}'`)})`;
  }
  return sql<string>`lower(${out})`;
}

/** Minúsculas e sem acento, do lado do Node. Mesma regra do front. */
export function semAcento(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Junta as colunas num alvo único de busca. Concatenar ANTES de normalizar faz
 * a cadeia de `replace` rodar uma vez só por linha, em vez de uma por coluna.
 * `coalesce` porque `||` com NULL no SQLite devolve NULL e apagaria o alvo
 * inteiro por causa de uma marca em branco.
 */
export function alvoDeBusca(colunas: Array<SQLWrapper | SQL>): AlvoDeBusca {
  const partes = colunas.map((c) => sql`coalesce(${c}, '')`);
  const texto = sql.join(partes, sql` || ' ' || `);
  return {
    minusculos: normalizarSql(texto, ACENTOS),
    maiusculos: normalizarSql(
      texto,
      ACENTOS.map(([de, para]) => [de.toUpperCase(), para] as const),
    ),
  };
}

/**
 * Separa o termo em palavras normalizadas. `%`, `_` e `\` viram literais: sem
 * isso "50%" casaria com qualquer coisa, porque `%` é curinga do LIKE.
 */
export function palavrasDoTermo(termo: string): string[] {
  return semAcento(termo)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_PALAVRAS)
    .map((p) => p.replace(/[\\%_]/g, (c) => `\\${c}`));
}

/**
 * Condição de busca: casa quando TODAS as palavras aparecem no alvo, em
 * qualquer ordem — "ferrari hot wheels" acha "Hot Wheels Ferrari Testarossa",
 * que a comparação de frase inteira deixava passar. `undefined` quando o termo
 * não tem palavra nenhuma (chamador não deve filtrar).
 */
export function condicaoDeBusca(
  alvo: AlvoDeBusca,
  termo: string,
): SQL | undefined {
  const palavras = palavrasDoTermo(termo);
  if (palavras.length === 0) return undefined;

  const condicoes = palavras.map((p) => {
    const padrao = `%${p}%`;
    return sql`(${alvo.minusculos} like ${padrao} escape '\\' or ${alvo.maiusculos} like ${padrao} escape '\\')`;
  });
  return sql.join(condicoes, sql` and `);
}
