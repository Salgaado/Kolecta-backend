// Slug de loja para a URL raiz (kolecta.com.br/<slug>).
//
// Como o slug mora na RAIZ, ele não pode colidir com nenhuma rota do site
// (atual ou futura). RESERVADOS bloqueia isso na geração; a rota `/:slug` do
// front ainda é a última (as estáticas ganham por especificidade), mas gerar um
// slug reservado deixaria uma loja inalcançável, então barramos aqui também.

/** Todas as rotas de topo do app + arquivos servidos na raiz. Manter em dia. */
export const SLUGS_RESERVADOS = new Set<string>([
  'busca', 'produto', 'modo-lance', 'comunidade', 'categorias', 'categoria',
  'vendedor', 'como-funciona', 'fundadores', 'carrinho', 'checkout', 'pedido',
  'entrar', 'criar-conta', 'esqueci-senha', 'conta', 'painel', 'admin',
  'connect', 'termos', 'privacidade', 'ajuda', 'seguranca',
  'taxas-e-comissoes', 'loja', 'lojas', 'api', 'assets', 'sitemap.xml',
  'robots.txt', 'favicon.ico', 'favicon.png', 'apple-touch-icon.png',
  'og-image.jpg', 'images', 'sobre', 'blog', 'contato', 'app', 'index.html',
  'null', 'undefined',
]);

/** Normaliza um nome em slug: sem acento, minúsculo, só a-z0-9 e hífen. */
export function slugify(nome: string | null | undefined): string {
  return (nome ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/**
 * Slug único a partir de um nome: normaliza, evita reservados e colisões
 * (sufixo -2, -3, ...). `usados` são os slugs já ocupados.
 */
export function slugUnico(nome: string | null | undefined, usados: Set<string>): string {
  const base = slugify(nome) || 'loja';
  const ocupado = (s: string) => SLUGS_RESERVADOS.has(s) || usados.has(s);
  if (!ocupado(base)) return base;
  let i = 2;
  while (ocupado(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
