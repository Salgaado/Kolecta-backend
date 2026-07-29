# Backend: arquitetura e domínio

## Resumo

`kolecta-backend` é uma aplicação NestJS 11 em TypeScript. Ela expõe 132 operações HTTP distribuídas em 30 controllers, usa validação global com `class-validator`, persiste 31 tabelas por Drizzle ORM sobre libSQL/Turso e coordena integrações externas por services, webhooks, eventos internos e cron jobs.

## Stack

| Responsabilidade | Tecnologia |
|---|---|
| Runtime/API | Node.js, NestJS 11, Express |
| Linguagem | TypeScript 5.7 |
| Validação | `class-validator`, `class-transformer` |
| Banco | Turso/libSQL; SQLite `local.db` como fallback local |
| ORM/schema | Drizzle ORM / Drizzle Kit |
| Identidade | Clerk |
| Pagamento atual | Pagar.me Core v5 |
| Pagamento legado | Stripe e Stripe Connect |
| Frete | Melhor Envio |
| Arquivos | Cloudflare R2 via SDK S3 |
| E-mail | Resend |
| ERP | Bling OAuth v3/API |
| Jobs/eventos | `@nestjs/schedule`, `@nestjs/event-emitter` |
| Testes | Jest, ts-jest, Supertest |

## Inicialização

`src/main.ts`:

- carrega variáveis com `dotenv`;
- cria o Nest com `rawBody: true`, necessário para verificar assinaturas de webhook;
- instala `ValidationPipe` com `transform` e `whitelist`;
- habilita CORS para `kolecta.com.br`, preview Vercel e portas locais 5173/8080;
- permite `Content-Type`, `Accept`, `Authorization` e `x-dev-user-id`;
- ativa middleware Clerk em produção ou quando existe chave publicável;
- escuta `PORT`, ou 3000, em `0.0.0.0`.

`src/app.module.ts` monta:

- infraestrutura global de banco, eventos e agendamento;
- pagamentos Pagar.me e Stripe legado;
- autenticação e usuários;
- módulos de marketplace, operação, comunidade e administração.

O `DevAuthMiddleware` só é aplicado fora de produção.

## Estrutura

```text
src/
├── main.ts
├── app.module.ts
├── auth/                 autenticação Clerk, roles e mock local
├── database/             conexão global, schema, seeds e utilitários
├── listings/             anúncios, moderação, publicação e importação
├── auctions/             leilões, lances, pré-auth e crons
├── orders/               checkout, pedidos, split, retenção e liberação
├── pagarme/              cliente Core v5, config, split e webhook
├── stripe/               webhooks e cliente legado
├── wallet/               saldo interno e ledger
├── recipients/           recebedor Pagar.me e KYC
├── withdrawals/          solicitações e transferências
├── shipping/             cotação e etiqueta Melhor Envio
├── notifications/        listeners, Resend e templates
├── community/            feed, interações, ranking e moderação
├── founder/              programa fundador e créditos
├── admin/                métricas e operações administrativas
└── demais módulos de domínio
```

## Convenções transversais

### Validação e serialização

DTOs rejeitam tipos e valores inválidos. `whitelist: true` remove propriedades que não existem no DTO; adicionar um campo apenas ao frontend não o torna persistente. Valores monetários são inteiros em centavos. Datas persistidas pelo Drizzle usam timestamp.

As respostas não seguem um envelope único:

- muitas rotas retornam `{ data: ... }`;
- feeds usam `data` e `meta`;
- cotação usa `{ options: ... }`;
- alguns services retornam objeto direto;
- webhooks retornam confirmação simples.

O cliente já acomoda essas diferenças, mas novos endpoints deveriam escolher e manter um padrão.

### Autenticação

- `AuthGuard`: exige `userId` do Clerk; em desenvolvimento aceita o mock previamente injetado.
- `RolesGuard`: busca o usuário no Turso e testa o decorator `@Roles`.
- sem `@Roles`, uma rota com `AuthGuard` aceita qualquer autenticado.
- controllers admin usam `@Roles('admin')` na classe.

Em desenvolvimento:

```http
x-dev-user-id: seller-001
```

Se o header estiver ausente, esse mesmo ID é o fallback. `NODE_ENV=production` é, portanto, uma configuração de segurança obrigatória no deploy.

### Persistência

`DatabaseModule` é global e fornece `DATABASE_CONNECTION`. Quando `TURSO_DATABASE_URL` não existe, usa `file:local.db`. O schema fica em um único arquivo, `src/database/schema.ts`, ponto de maior centralidade do backend.

Não há diretório de migrations Drizzle versionado visível no estado analisado. Alterações históricas de banco aparecem como scripts `add-*`, `ensure-*` e `backfill-*`. Isso exige disciplina operacional; veja [Operação](./06-operacao.md).

### Eventos

O EventEmitter desacopla fatos de negócio de efeitos secundários:

| Evento | Origem | Consumidores principais |
|---|---|---|
| `user.registered` | webhook Clerk | e-mail de boas-vindas |
| `listing.moderated` | ListingsService | e-mail de aprovação/reprovação |
| `auction.bid.placed` | AuctionsService | avisos ao vendedor e superado |
| `auction.won` | AuctionsService | vencedor, vendedor e etiqueta |
| `order.paid` | OrdersService | e-mails, Bling e etiqueta |
| `order.shipped` | OrdersService | e-mail ao comprador |
| `message.received` | MessagesService | aviso ao destinatário |
| `dispute.opened` | DisputesService | aviso de disputa |
| `payout.released` | WalletService | aviso financeiro |
| `recipient.kyc.approved` | RecipientsService | e-mail de aprovação |
| `recipient.kyc.action_needed` | RecipientsService | e-mail de ação |
| `shipping.label.ready` | ShippingService | e-mail com etiqueta |
| `pagarme.order.paid` | webhook Pagar.me | confirmação do pedido |
| `pagarme.order.failed` | webhook Pagar.me | falha/cancelamento |
| `pagarme.charge.chargedback` | webhook Pagar.me | chargeback |
| `pagarme.recipient.updated` | webhook Pagar.me | sincronização de KYC |
| `pagarme.transfer.updated` | webhook Pagar.me | sincronização de saque |
| `stripe.account.updated` | webhook Stripe | sincronização Connect legado |

## Módulos

### `users` e `webhook`

`users` espelha a identidade Clerk no banco, cria usuário sob demanda, atualiza nome/CPF/telefone e registra consentimentos de Termos/LGPD.

`webhook` verifica assinatura Svix do Clerk e trata criação, atualização e exclusão. Criação emite `user.registered`.

### `listings`

Responsável por:

- catálogo público filtrado no banco: categoria (id ou slug, incluindo subcategorias), busca `q` sem acento e sem caixa, condição, tipo, faixa de preço, e paginação por `limit/offset` ou `page` com `total`/`totalPages` no `meta`;
- leitura do anúncio;
- anúncios do próprio vendedor;
- criação e edição com verificação de propriedade;
- exclusão;
- envio para moderação;
- mudança de status por admin;
- pausa/retomada;
- importação CSV/XLSX, template e acompanhamento do job.

Campos principais:

- identidade comercial: título, descrição, categoria, marca, linha, escala, ano e edição;
- condição e tipo `direct|auction`;
- preço;
- SKU e estoque;
- atributos flexíveis como JSON;
- fotos como JSON stringificado;
- peso e dimensões;
- status/moderação;
- destaque.

Um anúncio de leilão criado pelo fluxo de listing também cria sua configuração de leilão. O término fica sem relógio até aprovação. As regras de publicação são centralizadas em `listing-publish-rules.ts`; importação possui regras próprias em `import-rules.ts`.

A busca sem acento é feita em SQL por `src/common/busca-sql.ts`, que espelha o
`src/lib/busca.ts` do frontend. O SQLite não tem `unaccent` e seu `lower()` só
entende ASCII, então o alvo é normalizado por cadeias de `replace`. Elas são
propositalmente rasas: o parser do SQLite estoura entre 24 e 29 chamadas
aninhadas, e cobrir maiúsculas e minúsculas numa cadeia só passa disso. Por isso
o texto é normalizado em duas versões, uma para cada caixa de acento, e cada
palavra procurada casa em qualquer uma delas.

### `auctions`

Gerencia:

- listagem pública e detalhe;
- leilões do vendedor e lances do usuário;
- criação direta de leilão;
- lance;
- encerramento manual/autorizado;
- encerramento automático;
- pré-autorização e reautorização de cartão;
- captura do vencedor;
- pedido pendente quando captura falha;
- expiração do prazo de pagamento.

Regras importantes:

- não aceita lance do próprio vendedor;
- valor deve respeitar lance atual/inicial e incremento;
- leilão pausado continua `active`, porém não recebe lance nem encerra;
- anti-sniper estende o relógio;
- o lance líder guarda referências Pagar.me e validade da autorização;
- término sem sucesso de captura não deve perder rastreabilidade: cria `pending_payment`.

### `orders`

É o maior agregado transacional. Faz:

- criação simples de pedidos;
- checkout com wallet/Pagar.me;
- cálculo de preço, frete, comissão, juros e split;
- simulação de parcelas;
- consultas de compras e vendas;
- detalhe autorizado apenas às partes;
- transição de status;
- cancelamento de PIX pendente;
- entrega e confirmação;
- tratamento de webhooks;
- chargeback;
- liberação de saldo.

O DTO aceita um ou mais `listingId`, endereço salvo ou novo, frete, serviço, retirada, uso de wallet, PIX/cartão, token, parcelas, CPF e telefone.

O backend relê preços e recalcula tudo. `paymentMethod` no DTO representa o instrumento externo; no banco, `paymentMethod` representa composição `wallet|external|hybrid`, enquanto `paymentInstrument` registra `pix|credit_card`.

Cada pedido liga um comprador, um vendedor e um anúncio. Um carrinho com vendedores diferentes produz pedidos separados.

A confirmação do pagamento também dá baixa no estoque do anúncio. A subtração é
feita pelo banco, condicionada a `stock > 0`, e não por leitura seguida de
escrita: sem isso duas compras simultâneas da última unidade levariam o estoque
a negativo. Sobrando estoque, o anúncio continua ativo; zerando, vai para
`paused`; sem estoque informado, mantém a regra antiga de unidade única e vai
para `sold`.

### `wallet`, `deposits` e `withdrawals`

`wallet` mantém:

- saldo disponível;
- saldo retido;
- saque em processamento;
- ledger de transações.

Possui operações de crédito, débito, retenção, liberação e ciclo de hold para lances.

`deposits` cria depósito PIX pela Pagar.me em `/api/wallet/deposit`.

`withdrawals` valida valor mínimo e capacidade do recebedor, reserva saldo, cria transferência Pagar.me e atualiza/estorna conforme webhook.

### `pagarme`, `recipients` e `cards`

`pagarme` encapsula requests Core v5, autenticação Basic, tratamento de erros, split e webhook.

`recipients` cadastra pessoa física ou jurídica, conta bancária, endereço e sócios; consulta status, gera link KYC e sincroniza flags de recebimento/saque.

`cards` guarda somente:

- `card_id` Pagar.me;
- bandeira;
- últimos quatro;
- titular;
- validade.

O modelo atual permite um cartão salvo por usuário. O backend nunca deve receber PAN/CVV.

### `stripe` e `connect`

São módulos legados ainda carregados:

- webhook Stripe clássico;
- thin webhook v2;
- onboarding/login/status/conta bancária do Stripe Connect.

O frontend redireciona a antiga página de onboarding Stripe para recebedor Pagar.me, mas callbacks e API Connect ainda existem. Remoção exige antes confirmar que não há conta, evento ou dado legado dependente.

### `shipping`

Integra Melhor Envio para:

- cotação pública;
- geração manual autenticada;
- emissão automática por pedido pago/arremate;
- retry;
- proxy/download de PDF.

Valida que pedido está pago, é de envio, pertence ao vendedor e possui origem/destino válidos. Persiste etapas e ID do carrinho para evitar cobrança/etiqueta duplicada.

### `notifications`

Envia e-mails por Resend e registra cada tentativa em `email_log`. A chave lógica `template + refId + recipient` evita duplicidade.

Templates encontrados:

- boas-vindas;
- anúncio aprovado/reprovado;
- pedido confirmado e venda realizada;
- pedido enviado;
- etiqueta pronta;
- lance recebido, lance superado e leilão vencido;
- mensagem recebida;
- disputa aberta;
- repasse liberado;
- KYC aprovado ou com ação necessária.

`MAIL_ENABLED` controla envio; ausência de configuração deve resultar em skip controlado, não em queda do fluxo principal.

### `addresses`

CRUD da agenda do usuário. Ao marcar um endereço como padrão, o service desmarca os demais. Checkout também pode criar um endereço informado na hora.

### `favorites`

Lista, alterna e remove favoritos. O toggle retorna se ficou favoritado.

### `messages`

Conversa é definida por anúncio, comprador e vendedor. Pode começar pelo anúncio ou a partir de um pedido. Acesso exige que o usuário seja participante. Mensagens possuem `readAt`.

### `reviews`

Avaliação bilateral pós-transação. Exige pedido válido, participante autorizado, nota de 1 a 5 e impede situações inválidas/duplicadas conforme service.

### `disputes`

Comprador ou vendedor abre disputa associada a pedido elegível, lista as próprias, consulta detalhe e adiciona mensagens à timeline. A abertura emite evento. Admin lista e resolve, registrando resolução e evento de sistema.

### `sellers`

Expõe perfil público, anúncios e avaliações. Na área autenticada, permite atualizar:

- dados da loja;
- avatar, cidade, estado, site e categorias;
- políticas de envio, devolução e pagamento;
- ofertas/desconto;
- preferências de notificação.

### `categories`

Lista a árvore de categorias. O schema suporta `parentId`; os atributos específicos de categoria são definidos de forma flexível no anúncio e interpretados pelo frontend.

### `community`

Feed, destaques, tendências, posts, comentários, like, save, pin e denúncias. Admin possui fila, mudanças de status e banimento.

O score é materializado e usa interações/recência. Contadores ficam no post para leitura rápida e são ajustados atomicamente pelo service.

### `founder`

Implementa:

- avaliação de elegibilidade, que só move o `founderStatus` e nunca atribui número;
- concessão pela equipe, com número escolhido em `0` (a casa) ou `1..100`;
- resgate de convite, na faixa 1..50 dos códigos do evento presencial. Como a concessão manual usa a mesma faixa, ela dá baixa no código de mesmo número, para que ninguém tente resgatar um número já concedido e bata no índice único;
- selo público;
- status do próprio vendedor;
- crédito de destaque;
- comissão especial;
- manutenção por inatividade.

### `admin`

Oferece:

- estatísticas;
- overview;
- relatórios;
- financeiro;
- monitor de leilões;
- vendedores detalhados;
- usuários e roles;
- verificação de vendedor;
- disputas;
- fila/moderação de anúncios;
- candidatos e concessão de fundador;
- envio de e-mail de teste.

### `media`

Upload autenticado de imagem ao Cloudflare R2. Retorna URL pública baseada em `CLOUDFLARE_R2_PUBLIC_URL`.

### `bling`

OAuth v3 por vendedor, armazenamento/refresh de tokens, desconexão e criação de pedido de venda quando `order.paid` é emitido.

## Cron jobs

| Frequência | Rotina |
|---|---|
| a cada 5 minutos | encerra leilões expirados |
| a cada 6 horas | reautoriza lances próximos do vencimento |
| a cada hora | expira pagamentos pendentes de arremate |
| a cada 30 minutos | libera saldos cujo prazo terminou |
| a cada hora | varre PIX pendentes expirados, reconciliando antes de cancelar |
| a cada 15 minutos | recalcula ranking da comunidade |
| diariamente às 03:00 | manutenção do programa fundador |

Em deploy com múltiplas réplicas, esses jobs rodariam em cada instância. O código analisado não apresenta lock distribuído; idempotência transacional precisa ser a proteção ou os jobs devem ser isolados.

## Webhooks

| Endpoint | Provedor | Verificação |
|---|---|---|
| `/api/webhooks/clerk` | Clerk/Svix | headers Svix + secret |
| `/api/webhooks/pagarme` | Pagar.me | Basic Auth configurável |
| `/api/webhooks/stripe` | Stripe clássico | assinatura Stripe |
| `/api/webhooks/stripe-v2` | Stripe thin events | secret próprio |

O raw body é habilitado globalmente. Eventos financeiros usam `webhook_events` para idempotência, embora o campo legado `stripeEventId` ainda seja reutilizado em partes da migração.

## Testes

Estado verificado:

- 29 suítes unitárias;
- 325 testes passando;
- build Nest concluído.

Cobertura funcional visível inclui autenticação, usuários, anúncios, publicação/importação, pedidos, split de frete, parcelas, leilões, Pagar.me, wallet, saques, frete, comunidade, fundador, admin, favoritos, endereços, mensagens, reviews e webhooks.

Três suítes fogem do padrão de mock e rodam contra um **SQLite em memória de
verdade** (`busca-sql.spec.ts`, `listings-filtros.spec.ts`,
`orders.estoque.spec.ts`), com as tabelas geradas a partir do próprio
`schema.ts` via `getTableConfig`. É deliberado: o que quebra nesses três pontos
não é lógica de JavaScript, é o SQL — mock de Drizzle não pega SQL que o banco
recusa, nem coluna que existe no schema e não no banco, que são justamente os
dois incidentes que já derrubaram `/api/listings`.

Há testes E2E em `test/` para aplicação, admin e leilões. Eles não fizeram parte da verificação desta fotografia.
