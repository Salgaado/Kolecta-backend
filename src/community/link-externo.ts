// Link externo em comentário da comunidade — regra PURA, sem Nest e sem banco.
//
// O gatilho foi concreto: em 05/08/2026 havia três comentários no ar apontando
// para `raapcollection.com.br`, uma loja concorrente de miniatura. Um terço de
// tudo que já tinha sido comentado na comunidade.
//
// Moderar depois é enxugar gelo: quem faz isso posta de novo, e alguém precisa
// estar olhando. Bloquear na escrita ataca a causa, e o custo é baixo porque
// comentário raramente precisa de link para fora.
//
// O que NÃO é bloqueado, de propósito:
//   - link para a própria Kolecta, que é o comportamento que a gente QUER
//     (mandar o colega para um anúncio da plataforma);
//   - texto sem link nenhum, obviamente;
//   - publicação (post), que é outro caso: um guia sobre miniatura tem motivo
//     legítimo para citar um vídeo ou uma referência de fora. Lá a tela de
//     moderação só sinaliza, e um humano decide.

/** Domínios que contam como "dentro de casa". */
const DOMINIOS_PROPRIOS = [
  'kolecta.com.br',
  'www.kolecta.com.br',
  'kolecta.vercel.app',
  'localhost',
];

/**
 * Pega qualquer coisa parecida com URL, e não só `http://`.
 *
 * Quem quer divulgar escreve `loja.com.br/produto` sem esquema nenhum, e uma
 * regex que só olhasse `https?://` deixaria passar exatamente o caso que
 * motivou a regra.
 */
const PADRAO_URL =
  /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/\S*)?/gi;

/** Domínios citados no texto que NÃO são da Kolecta. Vazio = pode publicar. */
export function linksExternosEm(texto: string | null | undefined): string[] {
  const achados = String(texto ?? '').match(PADRAO_URL) ?? [];
  const fora = new Set<string>();

  for (const bruto of achados) {
    const dominio = bruto
      .replace(/^https?:\/\//i, '')
      .split(/[/?#]/)[0]
      .toLowerCase();

    // Precisa de ponto e de uma terminação de letras: evita que "1:64" ou
    // "R$ 149.90" sejam lidos como domínio e o comentário seja recusado por
    // escrever escala ou preço.
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dominio)) continue;

    const proprio = DOMINIOS_PROPRIOS.some(
      (d) => dominio === d || dominio.endsWith(`.${d}`),
    );
    if (!proprio) fora.add(dominio);
  }

  return [...fora];
}

/**
 * Mensagem para o autor, ou `null` quando o comentário pode ser publicado.
 *
 * Diz QUAL domínio travou e o que fazer, em vez de "conteúdo não permitido":
 * quem colou um link sem má intenção precisa entender o que corrigir, e quem
 * colou de propósito já sabe.
 */
export function motivoDeRecusa(texto: string | null | undefined): string | null {
  const externos = linksExternosEm(texto);
  if (externos.length === 0) return null;

  return (
    `Comentário não pode ter link para fora da Kolecta (${externos.join(', ')}). ` +
    `Se quer mostrar uma peça, use o link do anúncio aqui da plataforma.`
  );
}
