# Backend: referência da API

## Convenções

Base local padrão: `http://localhost:3000`.

| Acesso | Significado |
|---|---|
| Público | não usa `AuthGuard` |
| Autenticado | Bearer Clerk; em desenvolvimento aceita `x-dev-user-id` |
| User/Admin | autenticado e role `user` ou `admin` |
| Admin | autenticado e role `admin` |
| Webhook | autenticado pela assinatura/credencial do provedor |
| Sessão esperada | controller lê a sessão, mas não declara `AuthGuard` explicitamente |

O backend não usa prefixo global; `api` faz parte do path declarado por cada controller. A exceção é o health/root `GET /`.

## Saúde

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/` | Público | resposta simples de disponibilidade da aplicação |

## Usuários e consentimento

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/users/me` | Autenticado | obtém ou cria o perfil do usuário logado |
| PATCH | `/api/users/me` | Autenticado | atualiza nome, CPF e/ou telefone |
| POST | `/api/users/me/consent` | Autenticado | registra versão e instante do aceite de Termos/LGPD |

## Anúncios

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/listings` | Público | catálogo filtrado e paginado no banco (ver abaixo) |
| GET | `/api/listings/admin` | Admin | listagem administrativa; query `status`, `limit`, `offset` |
| GET | `/api/listings/my` | User/Admin | anúncios do vendedor logado |
| POST | `/api/listings/import` | User/Admin | inicia importação CSV/XLSX multipart no campo `file` |
| GET | `/api/listings/import/template` | Público | devolve URL/dados do modelo de importação |
| GET | `/api/listings/import/:jobId` | User/Admin | acompanha job pertencente ao vendedor |
| GET | `/api/listings/:id` | Público | detalhe de anúncio |
| POST | `/api/listings` | User/Admin | cria anúncio direto ou leilão |
| PATCH | `/api/listings/:id` | User/Admin | edita anúncio pertencente ao vendedor |
| POST | `/api/listings/:id/publish` | User/Admin | valida e envia anúncio para moderação |
| PATCH | `/api/listings/:id/status` | Admin | muda status do anúncio |
| PATCH | `/api/listings/:id/toggle-pause` | User/Admin | pausa/retoma anúncio e leilão relacionado |
| DELETE | `/api/listings/:id` | User/Admin | remove anúncio permitido do vendedor |

### `GET /api/listings` — filtros da vitrine

Todos os filtros são aplicados em SQL. Até 27/07/2026 o endpoint aceitava apenas
`limit`, `offset` e um `LIKE` cru no título, e o frontend baixava o catálogo
inteiro para filtrar no navegador.

| Query | Exemplo | Comportamento |
|---|---|---|
| `limit` | `limit=20` | default 20, teto 500 |
| `offset` | `offset=40` | tem precedência sobre `page` |
| `page` | `page=3` | atalho para `offset = (page - 1) * limit` |
| `q` | `q=pokemon` | busca sem acento e sem caixa em título, marca, linha, descrição, SKU, edição e nome da loja; todas as palavras precisam casar, em qualquer ordem; máximo de 6 palavras |
| `category` ou `categoryId` | `category=cards-colecionaveis` | aceita id ou slug; categoria raiz inclui as subcategorias |
| `condition` | `condition=novo-lacrado,usado-conservado` | uma ou várias, separadas por vírgula; casamento exato |
| `type` | `type=auction` | `direct` ou `auction` |
| `minPrice` / `maxPrice` | `minPrice=10000` | centavos; em leilão compara com o lance atual, ou o inicial quando ainda não houve lance |

Resposta:

```jsonc
{
  "data": [ /* anúncios */ ],
  "meta": {
    "total": 668,
    "limit": 20,
    "offset": 0,
    "page": 1,
    "totalPages": 34,
    "hasMore": true
  }
}
```

O `total` é contado com exatamente os mesmos filtros da listagem, em consulta
paralela à dela.

Campos derivados presentes em `GET /api/listings` e `GET /api/listings/:id`:

| Campo | Origem |
|---|---|
| `sellerName` | `seller_profiles.store_name`, com `users.name` como alternativa |
| `sellerAvatarUrl` | `seller_profiles.avatar_url`, com `users.avatar_url` (foto do Clerk) como alternativa; `null` faz o frontend usar as iniciais |
| `sellerFounderNumber`, `sellerFounderStatus` | `seller_profiles`, para o selo sem consulta extra |
| `auctionId`, `startingBidInCents`, `currentBidInCents`, `reservePriceInCents`, `endsAt`, `auctionStatus`, `auctionPausedAt`, `bidsCount` | tabela `auctions` e contagem em `bids` |

Corpo principal de criação:

```ts
{
  title: string;
  description?: string;
  categoryId?: string;
  brand?: string;
  line?: string;
  scale?: string;
  year?: string;
  edition?: string;
  sku?: string;
  stock?: number;
  condition: string;
  type: "direct" | "auction";
  priceInCents?: number;
  startingBidInCents?: number;
  minIncrementInCents?: number;
  reservePriceInCents?: number;
  durationHours?: number;
  antiSniper?: boolean;
  attributes?: string; // JSON stringificado
  images?: string;     // JSON array stringificado
  weightGrams?: number;
  widthCm?: number;
  heightCm?: number;
  lengthCm?: number;
}
```

`type` não pode ser trocado na edição. Campos monetários são centavos.

## Categorias e vendedores

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/categories` | Público | lista categorias |
| GET | `/api/sellers/:id` | Público | perfil público por ID/slug resolvido pelo service |
| GET | `/api/sellers/:id/listings` | Público | anúncios do vendedor; query de paginação |
| GET | `/api/sellers/:id/reviews` | Público | avaliações recebidas; query `page`, `limit` |
| GET | `/api/seller/profile` | User/Admin | perfil da loja logada |
| PUT | `/api/seller/profile` | User/Admin | atualiza dados públicos da loja |
| PUT | `/api/seller/policies` | User/Admin | atualiza políticas e configuração de ofertas |
| PUT | `/api/seller/notification-preferences` | User/Admin | grava preferências como JSON |

## Leilões

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/auctions` | Público | lista leilões visíveis |
| GET | `/api/auctions/:id` | Público | detalhe do leilão |
| GET | `/api/auctions/bids/mine` | Autenticado | histórico/resumo de lances do usuário |
| GET | `/api/auctions/seller/mine` | Autenticado | leilões do vendedor |
| POST | `/api/auctions` | User/Admin | cria leilão para um listing |
| POST | `/api/auctions/:id/end` | User/Admin | encerra leilão quando permitido |
| POST | `/api/auctions/orders/:orderId/pay` | Autenticado | vencedor paga arremate `pending_payment` |
| POST | `/api/auctions/:id/bids` | Autenticado | oferece lance |

Criação:

```ts
{
  listingId: string;
  startingBidInCents: number;
  minIncrementInCents?: number;
  reservePriceInCents?: number;
  durationHours?: number;
  antiSniper?: boolean;
}
```

Lance:

```ts
{ amountInCents: number }
```

O cartão usado pelo lance é o cartão salvo do usuário; o endpoint não recebe PAN/CVV.

## Pedidos e checkout

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| POST | `/api/orders` | User/Admin | cria pedidos sem iniciar o checkout externo |
| POST | `/api/orders/checkout` | User/Admin | cria pedidos e inicia wallet/PIX/cartão/híbrido |
| GET | `/api/orders/installments-simulation` | User/Admin | simula parcelas; query `amount` em centavos |
| GET | `/api/orders/my/purchases` | User/Admin | compras do usuário |
| GET | `/api/orders/my/sales` | User/Admin | vendas do usuário |
| GET | `/api/orders/:id` | User/Admin | detalhe se usuário participa ou é autorizado |
| PATCH | `/api/orders/:id/status` | User/Admin | atualiza status/tracking conforme regras |
| PATCH | `/api/orders/:id/deliver` | User/Admin | vendedor marca entrega e inicia prazo |
| POST | `/api/orders/:id/confirm-delivery` | User/Admin | comprador confirma recebimento e libera saldo |
| POST | `/api/orders/:id/cancel` | User/Admin | comprador cancela PIX/pedido pendente elegível |

Checkout:

```ts
{
  items: Array<{ listingId: string }>;
  addressId?: string;
  shippingAddress?: {
    recipientName: string;
    street: string;
    number: string;
    complement?: string;
    neighborhood?: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
  };
  shippingInCents?: number;
  shippingServiceId?: number;
  shippingServiceName?: string;
  deliveryMethod?: "shipping" | "pickup";
  useWalletBalance?: boolean;
  paymentMethod?: "pix" | "credit_card";
  cardToken?: string;
  installments?: number; // 1..12
  buyerCpf?: string;
  buyerPhone?: string;
}
```

O endpoint recalcula preço, taxa, juros e split. Endereço salvo tem prioridade sobre `shippingAddress`.

## Wallet, depósito e saque

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/wallet/me` | User/Admin | saldo disponível, retido e em saque |
| GET | `/api/wallet/transactions` | User/Admin | ledger do usuário |
| POST | `/api/wallet/deposit` | User/Admin | cria depósito PIX |
| GET | `/api/withdrawals/me` | User/Admin | solicitações de saque do usuário |
| POST | `/api/withdrawals` | User/Admin | solicita saque Pagar.me |

Depósito:

```ts
{ amountInCents: number; cpf: string }
```

Saque:

```ts
{ amountInCents: number }
```

## Cartões salvos

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/cards` | Autenticado | cartão mascarado ou `null` |
| POST | `/api/cards` | Autenticado | associa token/card Pagar.me ao usuário |
| DELETE | `/api/cards` | Autenticado | remove cartão salvo |

O POST recebe token criado no frontend, dados de titular/CPF/telefone necessários à Pagar.me e nunca deve receber número completo ou CVV.

## Endereços

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/addresses` | Autenticado | lista endereços do usuário |
| POST | `/api/addresses` | Autenticado | cria endereço |
| PATCH | `/api/addresses/:id` | Autenticado | edita endereço pertencente ao usuário |
| DELETE | `/api/addresses/:id` | Autenticado | remove endereço |

Campos: label opcional, destinatário, logradouro, número, complemento, bairro, cidade, UF, CEP, país e flag padrão.

## Favoritos

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/favorites` | Autenticado | favoritos com resumo dos anúncios |
| POST | `/api/favorites` | Autenticado | alterna favorito para `listingId` |
| DELETE | `/api/favorites/:listingId` | Autenticado | remove explicitamente |

## Mensagens

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/messages/conversations` | User/Admin | conversas do participante |
| GET | `/api/messages/conversations/:id` | User/Admin | conversa e mensagens |
| POST | `/api/messages/conversations` | User/Admin | inicia conversa por anúncio |
| POST | `/api/messages/from-order/:orderId` | User/Admin | inicia/localiza conversa do pedido |
| POST | `/api/messages/conversations/:id` | User/Admin | envia mensagem |
| PATCH | `/api/messages/conversations/:id/read` | User/Admin | marca mensagens como lidas |

## Avaliações

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| POST | `/api/reviews` | User/Admin | cria avaliação pós-pedido |
| GET | `/api/reviews/received` | User/Admin | avaliações recebidas |
| GET | `/api/reviews/given` | User/Admin | avaliações escritas |

Criação:

```ts
{ orderId: string; rating: number; comment?: string }
```

`rating` aceita 1 a 5.

## Disputas

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/disputes` | User/Admin | disputas do usuário |
| GET | `/api/disputes/eligible-orders` | User/Admin | pedidos aptos a nova disputa |
| GET | `/api/disputes/:id` | User/Admin | detalhe e timeline |
| POST | `/api/disputes` | User/Admin | abre disputa |
| POST | `/api/disputes/:id/messages` | User/Admin | adiciona mensagem à timeline |

## Comunidade

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/community/feed` | Público | feed paginado e filtrável |
| GET | `/api/community/highlights` | Público | destaques agregados |
| GET | `/api/community/trends` | Público | tendências por janela `24h`, `7d` ou `month` |
| GET | `/api/community/posts/:id` | Público | detalhe do post ativo |
| GET | `/api/community/posts/:id/comments` | Público | comentários ativos |
| POST | `/api/community/posts` | User/Admin | cria post |
| PATCH | `/api/community/posts/:id` | User/Admin | edita post do autor |
| DELETE | `/api/community/posts/:id` | User/Admin | remove post do autor |
| POST | `/api/community/posts/:id/like` | User/Admin | alterna like |
| POST | `/api/community/posts/:id/save` | User/Admin | alterna save |
| POST | `/api/community/posts/:id/pin` | User/Admin | alterna pin |
| POST | `/api/community/posts/:id/comments` | User/Admin | adiciona comentário |
| POST | `/api/community/reports` | User/Admin | denuncia post ou comentário |

Feed aceita `page`, `limit`, `type`, `categoryId` e ordenação implementada pelo controller/service.

Post:

```ts
{
  type: "collection" | "product" | "discussion" | "guide";
  title: string;
  body?: string;
  images?: string[];
  categoryId?: string;
  listingId?: string;
}
```

Moderação:

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/community/admin/reports` | Admin | lista denúncias; query `status` |
| PATCH | `/api/community/admin/posts/:id/hide` | Admin | oculta post |
| PATCH | `/api/community/admin/posts/:id/remove` | Admin | remove post |
| PATCH | `/api/community/admin/posts/:id/restore` | Admin | restaura post |
| POST | `/api/community/admin/ban` | Admin | bane usuário da comunidade |
| POST | `/api/community/admin/unban` | Admin | remove banimento |

## Frete

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| POST | `/api/shipping/quote` | Público | cota Melhor Envio ou mock de desenvolvimento |
| POST | `/api/shipping/label` | Autenticado | gera etiqueta manual para pedido do vendedor |
| POST | `/api/shipping/label/:orderId/retry` | Autenticado | tenta novamente emissão automática |
| GET | `/api/shipping/label/:orderId/pdf` | Autenticado | entrega PDF por proxy autenticado |

Cotação:

```ts
{
  from_cep?: string;
  to_cep: string;
  weight_kg?: number;
  height_cm?: number;
  width_cm?: number;
  length_cm?: number;
  listing_id?: string;
}
```

Geração manual:

```ts
{
  order_id: string;
  service_id: number;
  origin_address_id: string;
  volumes: {
    weight_kg: number;
    width_cm: number;
    height_cm: number;
    length_cm: number;
  };
  declared_value?: number;
  to_document?: string;
  from_document?: string;
}
```

Retry e PDF permitem o vendedor do pedido ou admin.

## Mídia

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| POST | `/api/media/upload` | User/Admin | upload multipart de imagem ao R2 |

## Recebedores Pagar.me

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| POST | `/api/recipients/onboard` | User/Admin | cria/atualiza cadastro de recebedor |
| GET | `/api/recipients/status` | User/Admin | status KYC e permissões |
| POST | `/api/recipients/kyc-link` | User/Admin | gera link e QR de prova de vida |

Onboarding aceita `type=individual|company`, nome, documento, e-mail, telefone/site opcionais, dados pessoais ou empresariais, endereço, sócios administradores e conta bancária.

## Stripe Connect legado

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| POST | `/api/connect/onboard` | Sessão esperada | cria link de onboarding Stripe |
| GET | `/api/connect/status` | Sessão esperada | consulta capacidades/status |
| POST | `/api/connect/login` | Sessão esperada | cria login do dashboard Express |
| GET | `/api/connect/bank-account` | Sessão esperada | resumo da conta bancária |

Essas rotas verificam manualmente se há `userId`, mas não declaram `AuthGuard`; estão registradas como legado e merecem hardening antes de qualquer reutilização.

## Bling

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/bling/status` | Autenticado | status OAuth |
| GET | `/api/bling/connect` | Autenticado | redireciona para autorização |
| GET | `/api/bling/callback` | Público/OAuth | troca `code` e redireciona ao frontend |
| DELETE | `/api/bling/disconnect` | Autenticado | remove tokens |

Callback recebe `code` e `state`; o `state` identifica o usuário.

## Programa fundador

| Método | Path | Acesso | Finalidade |
|---|---|---|---|
| GET | `/api/founder/me` | Autenticado | avalia e retorna status/benefícios |
| POST | `/api/founder/redeem` | Autenticado | resgata código de convite |
| POST | `/api/founder/credits/use` | Autenticado | destaca anúncio consumindo crédito |
| GET | `/api/founder/:userId/badge` | Público | selo público ou `null` |

## Administração

Todas as rotas deste grupo usam `AuthGuard + RolesGuard` e exigem `admin`.

| Método | Path | Finalidade |
|---|---|---|
| GET | `/api/admin/stats` | totais e indicadores principais |
| POST | `/api/admin/test-email` | envia template de teste |
| GET | `/api/admin/overview` | séries, top sellers, categorias e pendências |
| GET | `/api/admin/reports` | GMV, métricas de leilão e categorias |
| GET | `/api/admin/financial` | resumo, transações e saques pendentes |
| GET | `/api/admin/auctions` | monitor de leilões |
| GET | `/api/admin/sellers/detailed` | vendedores com KYC e histórico |
| GET | `/api/admin/users` | usuários; query `limit`, `offset` |
| PATCH | `/api/admin/users/:id/role` | altera `user|admin` |
| GET | `/api/admin/sellers` | perfis; query `verified` |
| PATCH | `/api/admin/sellers/:id/verify` | marca/desmarca verificação |
| GET | `/api/admin/disputes` | disputas; query `status` |
| PATCH | `/api/admin/disputes/:id` | status/resolução |
| GET | `/api/admin/listings` | fila; query `status`, `limit`, `offset` |
| PATCH | `/api/admin/listings/:id/status` | modera com status/motivo |
| GET | `/api/admin/founders/candidates` | candidatos e próximo número livre em 1..100 |
| POST | `/api/admin/founders/:userId/grant` | concede número fundador; corpo `{ "number": 11 }`, aceita `0` (a casa) ou `1..100` |

## Webhooks

| Método | Path | Autenticação | Eventos principais |
|---|---|---|---|
| POST | `/api/webhooks/clerk` | Svix | `user.created`, `user.updated`, `user.deleted` |
| POST | `/api/webhooks/pagarme` | Basic Auth configurado | order paid/failed, refund, chargeback, recipient, transfer |
| POST | `/api/webhooks/stripe` | `stripe-signature` | checkout, payment intent, account updated |
| POST | `/api/webhooks/stripe-v2` | assinatura thin event | account created/updated/requirements |

Esses endpoints precisam receber o corpo bruto original. Não passe por proxy que transforme JSON antes da validação.

## Erros e segurança de consumo

- 400: DTO/assinatura/requisição inválida.
- 401: sessão ausente ou inválida.
- 403: role ou propriedade do recurso insuficiente.
- 404: recurso não encontrado.
- 409: conflito de estado ou duplicidade, quando aplicado pelo service.
- 422/erros de gateway podem ser traduzidos em mensagens de domínio.
- 500: falha interna ou integração.

O cliente deve exibir a mensagem retornada quando segura, mas não depender de texto para lógica; use status e estrutura.

