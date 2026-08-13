/**
 * Nome do vendedor como o público vê: o da LOJA quando existir, senão o pessoal.
 *
 * Quem vende como loja ("Culture TCG", "Safari TCG") cadastra o nome no painel
 * da Kolecta, em `seller_profiles.store_name`. O `users.name` é outra coisa:
 * vem do Clerk, é reescrito a cada `user.updated` e, para quem entrou só com
 * e-mail e senha, é a parte local do endereço. Numa tela pública de loja quem
 * manda é o cadastro da Kolecta — o do Clerk é a conta de e-mail do dono, e
 * mudar o nome lá não pode renomear a loja.
 *
 * O NULLIF trata string vazia como ausente: nome em branco é o mesmo que não
 * ter nome, e sem ele o COALESCE devolveria '' e o card ficaria sem vendedor.
 *
 * Mora aqui, e não dentro de cada service, porque a regra já valia na vitrine
 * (`listings`) e no leilão (`auctions`) e tinha ficado de fora justamente da
 * tela mais óbvia, o perfil da loja (`sellers`): o comprador via "Culture TCG"
 * no card e o nome pessoal do dono ao clicar nele — no título da página, nas
 * iniciais do avatar e no `<title>` que vai para o Google.
 *
 * Devolve uma expressão NOVA a cada chamada de propósito: a projeção precisa
 * apelidar (`.as('seller_name')`) e o filtro usa a crua, e um mesmo objeto
 * `sql` servindo aos dois é fonte de confusão na hora de mexer.
 */

import { sql } from 'drizzle-orm';
import { sellerProfiles, users } from '../database/schema';

export function nomeDeExibicaoDoVendedor() {
  return sql<string | null>`COALESCE(
    NULLIF(TRIM(${sellerProfiles.storeName}), ''),
    NULLIF(TRIM(${users.name}), '')
  )`;
}
