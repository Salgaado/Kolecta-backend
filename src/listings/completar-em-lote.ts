// Completar anúncios em massa — regras PURAS, sem Nest e sem banco.
//
// Nasceu da importação do Bling. O ERP entrega título, descrição, preço, peso,
// dimensões, marca, SKU e foto, o que já basta para publicar. Mas linha, ano e
// edição ficam vazios, e são justamente os campos que alimentam a busca e os
// filtros da vitrine: o anúncio entra no ar e some da navegação.
//
// Editar um por um não é opção para quem acabou de importar cem.
//
// A regra que sustenta tudo aqui é a mesma da importação: PREENCHE O QUE ESTÁ
// VAZIO, não sobrescreve. Aplicar "Mainline" a cinquenta anúncios não pode
// apagar o "Car Culture" que três deles já tinham certo.

/** Colunas próprias do anúncio que este fluxo aceita preencher. */
export const CAMPOS_COLUNA = ['brand', 'line', 'scale', 'year', 'edition'] as const;

export type CampoColuna = (typeof CAMPOS_COLUNA)[number];

export interface AnuncioParaCompletar {
  brand?: string | null;
  line?: string | null;
  scale?: string | null;
  year?: string | null;
  edition?: string | null;
  /** JSON stringificado das chaves por categoria (jogo, personagem, numero…). */
  attributes?: string | null;
}

export function vazio(valor: unknown): boolean {
  return valor === null || valor === undefined || String(valor).trim() === '';
}

export function lerAtributos(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    return Object.fromEntries(
      Object.entries(p).map(([k, v]) => [k, v == null ? '' : String(v)]),
    );
  } catch {
    return {};
  }
}

/**
 * O que falta neste anúncio, entre os campos pedidos.
 *
 * Serve para a tela mostrar "37 sem linha" em vez de obrigar o vendedor a abrir
 * um por um para descobrir.
 */
export function faltando(
  anuncio: AnuncioParaCompletar,
  campos: string[],
): string[] {
  const attrs = lerAtributos(anuncio.attributes);
  return campos.filter((campo) =>
    (CAMPOS_COLUNA as readonly string[]).includes(campo)
      ? vazio((anuncio as Record<string, unknown>)[campo])
      : vazio(attrs[campo]),
  );
}

export interface PatchDoAnuncio {
  colunas: Partial<Record<CampoColuna, string>>;
  /** JSON pronto para gravar, ou `null` quando os atributos não mudaram. */
  attributes: string | null;
}

/**
 * Monta o patch de UM anúncio.
 *
 * `sobrescrever` existe para o caso legítimo de corrigir em massa (o vendedor
 * digitou a linha errada em trinta anúncios), mas o padrão é false: quem clica
 * em "aplicar aos marcados" quase sempre quer preencher buraco, não apagar o
 * que já estava certo.
 *
 * Devolve `null` quando nada mudaria, para quem chama não gastar um UPDATE por
 * anúncio que já estava completo.
 */
export function montarPatch(
  anuncio: AnuncioParaCompletar,
  valores: Record<string, string>,
  sobrescrever = false,
): PatchDoAnuncio | null {
  const colunas: Partial<Record<CampoColuna, string>> = {};
  const attrs = lerAtributos(anuncio.attributes);
  let mexeuNosAtributos = false;

  for (const [campo, bruto] of Object.entries(valores)) {
    const valor = String(bruto ?? '').trim();
    if (!valor) continue; // string vazia não apaga nada, de propósito

    if ((CAMPOS_COLUNA as readonly string[]).includes(campo)) {
      const atual = (anuncio as Record<string, unknown>)[campo];
      if (sobrescrever || vazio(atual)) colunas[campo as CampoColuna] = valor;
    } else {
      if (sobrescrever || vazio(attrs[campo])) {
        attrs[campo] = valor;
        mexeuNosAtributos = true;
      }
    }
  }

  if (Object.keys(colunas).length === 0 && !mexeuNosAtributos) return null;
  return {
    colunas,
    attributes: mexeuNosAtributos ? JSON.stringify(attrs) : null,
  };
}
