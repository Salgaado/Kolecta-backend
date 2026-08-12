/**
 * Cadastro placeholder: o estado em que um usuário nasce quando o Clerk não
 * respondeu a tempo no `user.created` — `name = "Novo Usuário"` e
 * `email = <id>@placeholder.kolecta`.
 *
 * O domínio não existe, então nenhum e-mail é entregue: foi assim que dois
 * avisos de arremate se perderam em 11/08. E não para no e-mail — para o
 * antifraude da Pagar.me, um cliente chamado "Novo Usuário" com e-mail de
 * domínio inexistente não identifica pessoa alguma.
 *
 * Por isso os dois viram `null` aqui: quem consome decide o que fazer com a
 * ausência, mas ninguém propaga esses dados adiante como se fossem reais.
 */
export const PLACEHOLDER_NAME = 'Novo Usuário';
export const PLACEHOLDER_EMAIL_SUFFIX = '@placeholder.kolecta';

/**
 * O mesmo rótulo aparece escrito das duas formas no histórico do banco (com e
 * sem acento), e a comparação não pode depender disso.
 */
const ROTULOS_DE_INCOMPLETO = new Set(['novo usuário', 'novo usuario']);

/** O e-mail identifica alguém? Devolve `null` quando é o sintético ou vazio. */
export function emailUtil(email?: string | null): string | null {
  const e = String(email ?? '').trim();
  if (!e) return null;
  return e.toLowerCase().endsWith(PLACEHOLDER_EMAIL_SUFFIX) ? null : e;
}

/** O nome identifica alguém? Devolve `null` quando é o rótulo do incompleto. */
export function nomeUtil(nome?: string | null): string | null {
  const n = String(nome ?? '').trim();
  if (!n) return null;
  return ROTULOS_DE_INCOMPLETO.has(n.toLowerCase()) ? null : n;
}
