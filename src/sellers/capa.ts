// ─── Capa (banner) da loja ───────────────────────────────────────────────────
//
// A faixa no topo do perfil do vendedor, no formato de LinkedIn/Twitter. Aqui
// ficam só os números e a resolução dos defaults, porque três lugares precisam
// deles e divergir seria pior que repetir: o DTO (que valida o que entra), o
// perfil público e o perfil autenticado (que devolvem o que sai).

/**
 * Escurecimento mínimo sobre a imagem, em %.
 *
 * É regra de legibilidade, não gosto. O nome da loja, o selo de verificado e as
 * estatísticas ficam POR CIMA da capa; sem um piso, a primeira foto clara que
 * alguém subir apaga o nome da própria loja. O vendedor escolhe a imagem — não
 * escolhe se dá para ler o que está em cima dela.
 */
export const COVER_OVERLAY_MIN = 35;
export const COVER_OVERLAY_MAX = 90;
export const COVER_OVERLAY_DEFAULT = 55;

/** Recorte vertical: 0 = topo, 100 = base. Centro é o palpite menos pior. */
export const COVER_FOCAL_DEFAULT = 50;

export type Capa = {
  url: string;
  focalY: number;
  overlay: number;
} | null;

/**
 * Monta o bloco `cover` da resposta a partir das colunas cruas.
 *
 * Devolve `null` quando não há capa (o front cai no cabeçalho de sempre) e, com
 * capa, devolve os três campos já resolvidos — inclusive o piso reaplicado.
 * Assim o front não repete a regra: qualquer valor fora da faixa que tenha
 * entrado no banco antes desta validação existir sai daqui corrigido.
 */
export function montarCapa(perfil: {
  coverUrl?: string | null;
  coverFocalY?: number | null;
  coverOverlay?: number | null;
}): Capa {
  if (!perfil?.coverUrl) return null;
  return {
    url: perfil.coverUrl,
    focalY: limitar(perfil.coverFocalY ?? COVER_FOCAL_DEFAULT, 0, 100),
    overlay: limitar(
      perfil.coverOverlay ?? COVER_OVERLAY_DEFAULT,
      COVER_OVERLAY_MIN,
      COVER_OVERLAY_MAX,
    ),
  };
}

function limitar(valor: number, min: number, max: number): number {
  if (!Number.isFinite(valor)) return min;
  return Math.min(max, Math.max(min, Math.round(valor)));
}

/**
 * A capa é nossa ou de terceiro?
 *
 * Só aceitamos imagem que subiu pelo nosso `/api/media/upload` e mora no R2.
 * URL de fora é problema em três frentes: o dono do servidor troca a imagem
 * DEPOIS de ela ter sido aprovada, ele passa a receber o IP de todo mundo que
 * abre a loja, e quando o link morrer a capa vira um buraco na página.
 *
 * Sem `CLOUDFLARE_R2_PUBLIC_URL` no ambiente (teste local, script), aceita:
 * travar o cadastro por falta de env seria pior que o risco que isto cobre.
 */
export function urlDeCapaAceita(url: string): boolean {
  const base = process.env.CLOUDFLARE_R2_PUBLIC_URL;
  if (!base) return true;
  return url.startsWith(base.replace(/\/+$/, '') + '/');
}
