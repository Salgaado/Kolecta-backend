// ─── Redes sociais da loja ───────────────────────────────────────────────────
//
// Os links de TikTok, Instagram, YouTube e site que o vendedor mostra no topo
// da própria loja. Aqui ficam a normalização e a allowlist, porque três lugares
// precisam delas e divergir seria pior que repetir: o DTO (o que entra), o
// perfil público e o perfil autenticado (o que sai).
//
// A regra que organiza o arquivo inteiro: guardamos o IDENTIFICADOR (o handle),
// nunca a URL. A URL é montada na saída. Isso vale por três motivos:
//
//   1. O que está gravado não é `href`. Um valor podre — de antes desta regra
//      existir, de um script, de uma correção na mão no banco — vira `null` na
//      saída em vez de virar link clicável numa página pública.
//   2. O domínio é nosso, não do vendedor. Trocar `youtube.com` por outro
//      domínio, ou passar a usar `www.`, é mexer aqui e em nenhum outro lugar.
//   3. O mesmo vendedor digitando `@loja`, `instagram.com/loja` ou a URL
//      inteira grava exatamente a mesma coisa.

/** Teto de tamanho do que entra. Mesmo valor do `@MaxLength` no DTO. */
export const REDE_MAX_LENGTH = 200;

export type Rede = 'tiktok' | 'instagram' | 'youtube';

/**
 * Domínios aceitos por rede.
 *
 * Sem esta lista, o campo "Instagram" vira um redirecionador aberto: o vendedor
 * grava qualquer URL e a loja — que é página pública e indexável — passa a
 * levar o visitante para onde ele quiser, com o ícone do Instagram do lado.
 *
 * `youtu.be` está de fora DE PROPÓSITO: é encurtador de VÍDEO, não de canal.
 * Aceitá-lo faria `youtu.be/dQw4w9WgXcQ` virar "canal dQw4w9WgXcQ" e o ícone
 * levaria a um 404.
 */
export const REDES_PERMITIDAS: Record<Rede, readonly string[]> = {
  tiktok: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com'],
  instagram: ['instagram.com', 'www.instagram.com'],
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com'],
};

/**
 * Esquemas que nunca podem chegar a um `href`.
 *
 * Testado ANTES de qualquer parse: o `new URL()` normaliza de formas
 * inesperadas, e o que interessa aqui é o que o navegador vai ver. O prefixo
 * tolera espaço e caractere de controle porque `\njavascript:` também executa.
 */
const ESQUEMAS_PROIBIDOS = /^\s*(javascript|data|vbscript|file)\s*:/i;

/** Já vem com protocolo? (`https://`, `http://`, e também o que for proibido) */
const TEM_PROTOCOLO = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Handle de rede social: letras, números, ponto, sublinhado e hífen. */
const HANDLE_VALIDO = /^[A-Za-z0-9._-]{1,50}$/;

/** Prefixos de caminho do YouTube que identificam um canal. */
const PREFIXOS_YOUTUBE = ['c', 'channel', 'user'] as const;

/**
 * Normaliza o que o vendedor digitou para o identificador que vai ao banco.
 *
 * Aceita as três formas que ele tem à mão — `@loja`, `loja`, e a URL inteira
 * copiada do navegador ou do app — e devolve sempre a mesma coisa. Devolve
 * `null` para qualquer entrada que não dê um link seguro e desta rede.
 *
 * O YouTube é o caso chato: um canal tem três endereços possíveis
 * (`/@nome`, `/c/nome`, `/channel/UC…`, mais o `/user/nome` antigo) e eles NÃO
 * são intercambiáveis. Por isso o valor gravado para o YouTube é o caminho
 * inteiro, e não só o handle.
 */
export function normalizarRede(
  rede: Rede,
  valor: string | null | undefined,
): string | null {
  const cru = semControles(valor ?? '').trim();
  if (!cru || cru.length > REDE_MAX_LENGTH) return null;
  if (ESQUEMAS_PROIBIDOS.test(cru)) return null;

  // Forma canônica do YouTube ja gravada ("c/nome", "channel/UC...").
  // Esta função roda tambem na SAÍDA, em cima do que veio do banco, e por isso
  // precisa ser idempotente: sem este atalho, "c/nome" cairia no caminho de URL
  // logo abaixo e o "c" viraria o domínio.
  if (rede === 'youtube') {
    const canonico = /^(c|channel|user)\/([A-Za-z0-9._-]{1,50})$/.exec(cru);
    if (canonico) return `${canonico[1]}/${canonico[2]}`;
  }

  // Forma "@loja": é o que está no perfil do app, e é o que o vendedor copia.
  if (cru.startsWith('@')) return identificador(rede, cru.slice(1));

  // Sem barra e sem protocolo é handle digitado sem o @. A checagem é por
  // BARRA, e não por ponto: "loja.nerd" é handle válido no Instagram, e testar
  // ponto mandaria ele para o caminho de URL e o transformaria num domínio.
  if (!cru.includes('/') && !TEM_PROTOCOLO.test(cru)) {
    return identificador(rede, cru);
  }

  const url = comoUrl(cru);
  if (!url) return null;
  if (!REDES_PERMITIDAS[rede].includes(url.hostname.toLowerCase())) return null;

  const partes = url.pathname
    .split('/')
    .filter(Boolean)
    .map((p) => decodeSeguro(p))
    .filter((p): p is string => p !== null);
  if (partes.length === 0) return null;

  if (rede === 'youtube') {
    const [primeiro, segundo] = partes;
    if (primeiro.startsWith('@')) {
      return identificador('youtube', primeiro.slice(1));
    }
    if ((PREFIXOS_YOUTUBE as readonly string[]).includes(primeiro)) {
      if (!segundo || !HANDLE_VALIDO.test(segundo)) return null;
      return `${primeiro}/${segundo}`;
    }
    // Caminho de um segmento só é a URL personalizada antiga
    // (youtube.com/nomedaloja), que ainda funciona. Guardamos como veio.
    if (partes.length === 1 && HANDLE_VALIDO.test(primeiro)) return primeiro;
    return null;
  }

  return identificador(rede, partes[0].replace(/^@/, ''));
}

export type RedesSociais = {
  tiktok: string | null;
  instagram: string | null;
  youtube: string | null;
  website: string | null;
} | null;

/**
 * Monta o bloco `social` da resposta a partir das colunas cruas.
 *
 * Devolve `null` quando não há NENHUMA rede válida — é o sinal para o front
 * omitir a fileira inteira, em vez de desenhar uma faixa vazia.
 *
 * Repare que ele normaliza de novo na SAÍDA, e não confia no que está gravado.
 * É a mesma decisão do `montarCapa()`, que reaplica o piso do escurecimento:
 * o valor pode ter entrado antes desta validação existir. Vale principalmente
 * para o `website`, que é campo livre desde sempre e já tem dados no banco.
 */
export function montarRedes(perfil: {
  socialTiktok?: string | null;
  socialInstagram?: string | null;
  socialYoutube?: string | null;
  website?: string | null;
}): RedesSociais {
  const bloco = {
    tiktok: urlDaRede('tiktok', perfil?.socialTiktok),
    instagram: urlDaRede('instagram', perfil?.socialInstagram),
    youtube: urlDaRede('youtube', perfil?.socialYoutube),
    website: urlDeWebsite(perfil?.website),
  };

  const temAlguma = Object.values(bloco).some((v) => v !== null);
  return temAlguma ? bloco : null;
}

/**
 * Os identificadores crus, para preencher os inputs das Configurações.
 *
 * O vendedor digitou `@loja` e precisa ver `@loja` de volta ao reabrir a tela —
 * não `https://www.instagram.com/loja`. São dois usos diferentes do mesmo dado:
 * `montarRedes` é para o `href`, este é para o `<input>`.
 */
export function handlesBrutos(perfil: {
  socialTiktok?: string | null;
  socialInstagram?: string | null;
  socialYoutube?: string | null;
  website?: string | null;
}): {
  tiktok: string | null;
  instagram: string | null;
  youtube: string | null;
  website: string | null;
} {
  return {
    tiktok: perfil?.socialTiktok ?? null,
    instagram: perfil?.socialInstagram ?? null,
    youtube: perfil?.socialYoutube ?? null,
    website: perfil?.website ?? null,
  };
}

/** Identificador gravado -> URL pronta para o `href`. */
export function urlDaRede(
  rede: Rede,
  valor: string | null | undefined,
): string | null {
  const id = normalizarRede(rede, valor);
  if (!id) return null;

  if (rede === 'tiktok') return `https://www.tiktok.com/@${id}`;
  if (rede === 'instagram') return `https://www.instagram.com/${id}`;
  return `https://www.youtube.com/${id}`;
}

/**
 * O site do vendedor, que é campo livre e aceita qualquer domínio.
 *
 * Ele existe desde antes desta feature, sempre foi salvo e NUNCA foi exibido.
 * Ao virar link clicável, o que já está gravado passa a importar: pode haver
 * texto solto, endereço sem protocolo ou um `javascript:` esperando um `href`.
 * Por isso o saneamento acontece aqui, na saída, e não só no DTO.
 */
export function urlDeWebsite(valor: string | null | undefined): string | null {
  const cru = semControles(valor ?? '').trim();
  if (!cru || cru.length > REDE_MAX_LENGTH) return null;
  if (ESQUEMAS_PROIBIDOS.test(cru)) return null;

  const url = comoUrl(cru);
  if (!url) return null;

  // Domínio precisa ter ponto e não ser máquina local: "localhost" ou
  // "intranet" num link público não leva o visitante a lugar nenhum.
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.local')) return null;

  return url.toString();
}

/**
 * Parse defensivo de URL.
 *
 * Recusa `usuário:senha@host`, que é o truque de
 * `https://instagram.com@evil.com/loja`: quem lê da esquerda para a direita vê
 * "instagram.com", mas o navegador vai para `evil.com`. A allowlist de hostname
 * já barra esse caso — a checagem de userinfo cobre o inverso
 * (`https://evil.com@instagram.com`), que passa na allowlist e continua sendo
 * um link feito para enganar quem passa o mouse em cima.
 */
/**
 * Tira caracteres de controle antes de qualquer checagem.
 *
 * O navegador ignora esses bytes ao resolver um `href`, então um NUL no meio
 * de "javascript:" ainda executa — mas passaria por um teste no texto cru.
 * A limpeza é por CÓDIGO de caractere, e não por regex: regex com caractere de
 * controle é ilegível e a regra `no-control-regex` recusa.
 */
function semControles(valor: string): string {
  return Array.from(valor)
    .filter((c) => {
      const codigo = c.charCodeAt(0);
      return codigo > 31 && codigo !== 127;
    })
    .join('');
}

function comoUrl(valor: string): URL | null {
  const comProtocolo = TEM_PROTOCOLO.test(valor) ? valor : `https://${valor}`;

  let url: URL;
  try {
    url = new URL(comProtocolo);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  return url;
}

/** Handle validado, ou `null`. O `@` já saiu antes de chegar aqui. */
function identificador(rede: Rede, handle: string): string | null {
  const limpo = handle.trim();
  if (!HANDLE_VALIDO.test(limpo)) return null;
  // No YouTube o handle moderno mora em `/@nome`, e é assim que ele é gravado:
  // sem o `@` o link cairia na URL personalizada antiga, que é outro endereço.
  return rede === 'youtube' ? `@${limpo}` : limpo;
}

/** `decodeURIComponent` que não estoura com `%` solto no caminho. */
function decodeSeguro(parte: string): string | null {
  try {
    return decodeURIComponent(parte);
  } catch {
    return null;
  }
}
