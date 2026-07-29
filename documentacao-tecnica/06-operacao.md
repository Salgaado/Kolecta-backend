# Operação, configuração e manutenção

## Pré-requisitos

- Node.js compatível com as dependências atuais; Node 22 é a referência sugerida pelos tipos do backend.
- npm.
- conta/credenciais dos serviços usados no ambiente alvo.
- para desenvolvimento sem Turso, o backend consegue usar `local.db`.

Não reutilize chaves de produção no frontend local. Variáveis `VITE_*` são embutidas no bundle e são públicas por definição.

## Desenvolvimento local

### Backend

```powershell
cd kolecta-backend
npm install
npm run start:dev
```

API: `http://localhost:3000`.

Sem Turso, a conexão cai para `file:local.db`. Fora de produção, `x-dev-user-id` permite alternar usuário. O frontend envia `seller-001` por padrão.

Comandos:

| Comando | Uso |
|---|---|
| `npm run start` | inicia Nest |
| `npm run start:dev` | watch |
| `npm run start:debug` | debug/watch |
| `npm run build` | compila em `dist` |
| `npm run start:prod` | executa `dist/main` |
| `npm test` | unitários Jest |
| `npm run test:watch` | watch de testes |
| `npm run test:cov` | cobertura |
| `npm run test:e2e` | E2E Nest |
| `npm run lint` | ESLint com fix |
| `npm run format` | Prettier em src/test |

### Frontend

```powershell
cd kolecta-the-collector-s-hub
npm install
npm run dev
```

SPA: `http://localhost:8080`.

Comandos:

| Comando | Uso |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | bundle de produção |
| `npm run build:dev` | bundle em modo development |
| `npm run preview` | serve `dist` |
| `npm test` | Vitest run |
| `npm run test:watch` | Vitest watch |
| `npm run lint` | ESLint |
| `npx playwright test` | E2E Playwright |

O repositório possui locks npm e Bun, mas os comandos declarados usam npm. Escolha um gerenciador por fluxo para evitar drift de lockfile.

## Variáveis do backend

### Runtime e banco

| Variável | Obrigatoriedade | Uso/default |
|---|---|---|
| `NODE_ENV` | obrigatória em produção | desativa autenticação mock |
| `PORT` | opcional | 3000 |
| `TURSO_DATABASE_URL` | produção | URL libSQL; sem ela usa `file:local.db` |
| `TURSO_AUTH_TOKEN` | Turso | token da base |
| `FRONTEND_URL` | recomendada | redirects OAuth; fallback `http://localhost:8080` |

### Clerk

| Variável | Uso |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | habilita middleware Clerk também fora de produção |
| `CLERK_SECRET_KEY` | consulta de identidade |
| `CLERK_WEBHOOK_SECRET` | validação Svix |

### Pagar.me

| Variável | Uso/default |
|---|---|
| `PAGARME_SECRET_KEY` | secret atual `sk_test` ou `sk_live` |
| `PAGARME_SECRET_KEY_LIVE` | referenciada por scripts/fluxos auxiliares |
| `PAGARME_BASE_URL` | default `https://api.pagar.me/core/v5` |
| `PAGARME_WEBHOOK_USER` | Basic Auth do webhook |
| `PAGARME_WEBHOOK_PASSWORD` | Basic Auth do webhook |
| `PAGARME_PLATFORM_RECIPIENT_ID` | recebedor Kolecta para split; sem ele o split externo é pulado |
| `PAGARME_GATEWAY_FEE_PERCENT` | bookkeeping geral; default 0 |
| `PAGARME_CARD_FEE_PERCENT` | bookkeeping de cartão; default 0 |
| `PAGARME_INSTALLMENT_INTEREST` | default `on`; `off` zera acréscimo de parcelamento |
| `PAGARME_PREAUTH_VALIDITY_DAYS` | default 5 |
| `PAGARME_REAUTH_WINDOW_HOURS` | default 24 |
| `AUCTION_PAYMENT_DEADLINE_HOURS` | default 24 |
| `PAGAMENTO_CARTAO_HABILITADO` | cartão só abre quando exatamente `true` |
| `ENFORCE_SELLER_KYC` | publicação/venda exige KYC quando exatamente `true` |

O host Pagar.me é o mesmo para sandbox e produção; a chave define o ambiente.

### Taxas e financeiro

| Variável | Uso/default |
|---|---|
| `PLATFORM_FEE_PERCENT` | comissão base; default 11 |
| `WITHDRAWAL_MIN_AMOUNT_CENTS` | mínimo de saque; default 5000 |

Fundador ativo pode receber percentual próprio calculado pelo `FounderService`.

Parcelamento usa uma tabela CET fixa no código para 1x a 12x. Mudança contratual com o gateway exige atualização e testes.

### Melhor Envio

| Variável | Uso/default |
|---|---|
| `MELHOR_ENVIO_API_URL` | host da API |
| `MELHOR_ENVIO_TOKEN` | autenticação |
| `SHIPPING_ORIGIN_CEP` | origem de fallback |
| `SHIPPING_FALLBACK_PHONE` | telefone quando cadastro não possui |
| `SHIPPING_DEFAULT_WEIGHT_KG` | default final 0,3 kg |
| `SHIPPING_DEFAULT_WIDTH_CM` | default final 16 |
| `SHIPPING_DEFAULT_HEIGHT_CM` | default final 6 |
| `SHIPPING_DEFAULT_LENGTH_CM` | default final 12 |
| `SHIPPING_FALLBACK_RELEASE_DAYS` | liberação sem rastreio; default 14 |

Prioridade de dimensão: request, listing, variável, default de código.

### Cloudflare R2

| Variável | Uso |
|---|---|
| `CLOUDFLARE_R2_ACCOUNT_ID` | endpoint S3 |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | credencial |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | credencial |
| `CLOUDFLARE_R2_BUCKET_NAME` | bucket |
| `CLOUDFLARE_R2_PUBLIC_URL` | URL retornada ao cliente |

### E-mail

O código referencia nomes atuais e aliases legados.

| Variável | Uso |
|---|---|
| `RESEND_API_KEY` | provedor |
| `MAIL_ENABLED` | habilita envio |
| `MAIL_FROM` / `EMAIL_REMETENTE` | remetente |
| `MAIL_REPLY_TO` / `EMAIL_RESPOSTA` | resposta |
| `MAIL_SITE_URL` | base de links |

### Bling

| Variável | Uso |
|---|---|
| `BLING_CLIENT_ID` | OAuth |
| `BLING_CLIENT_SECRET` | OAuth |
| `BLING_REDIRECT_URI` | callback cadastrado |

### Stripe legado

| Variável | Uso |
|---|---|
| `STRIPE_SECRET_KEY` | API |
| `STRIPE_PUBLISHABLE_KEY` | chave pública exposta por config interna |
| `STRIPE_WEBHOOK_SECRET` | webhook clássico |
| `STRIPE_THIN_WEBHOOK_SECRET` | thin events v2 |

## Variáveis do frontend

| Variável | Uso/default |
|---|---|
| `VITE_API_URL` | base da API; fallback `http://localhost:3000` |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk; sem ela o app entra em modo público degradado |
| `VITE_PAGARME_PUBLIC_KEY` | tokenização de cartão no navegador |
| `VITE_CARTAO_HABILITADO` | cartão só aparece quando `true` |
| `VITE_LAUNCH_DATE` | data ISO com offset; sem valor válido, site aberto |
| `VITE_ENV` | também ativa ferramentas de desenvolvimento quando `development` |

O backend e o frontend possuem flags separadas para cartão. As duas devem estar `true` para o fluxo funcionar; fechar qualquer uma deve impedir uso.

## Banco e schema

Configuração Drizzle:

```powershell
cd kolecta-backend
npx drizzle-kit generate
npx drizzle-kit push
```

Antes de executar contra produção:

1. confira a URL do ambiente;
2. faça backup;
3. gere e revise SQL;
4. audite duplicidades quando adicionar índices;
5. rode em staging/sandbox;
6. valide contratos frontend/backend;
7. só então aplique.

O estado analisado contém scripts históricos de alteração direta. Eles não devem ser executados em lote nem “por garantia”.

Atenção à ordem: colunas novas precisam existir no banco **antes** do deploy do
código que as lê. O `getTableColumns` do Drizzle projeta a coluna declarada no
`schema.ts`, então uma coluna sem `push` não degrada — derruba o endpoint
inteiro com 500. Já aconteceu com `/api/listings`.

Última alteração aplicada em produção (27/07/2026), aditiva e sem tocar em dado:

```sql
ALTER TABLE users ADD COLUMN avatar_url text;
CREATE INDEX IF NOT EXISTS listings_status_created_idx  ON listings (status, created_at);
CREATE INDEX IF NOT EXISTS listings_status_category_idx ON listings (status, category_id);
CREATE INDEX IF NOT EXISTS listings_seller_idx          ON listings (seller_id);
CREATE INDEX IF NOT EXISTS auctions_listing_idx         ON auctions (listing_id);
CREATE INDEX IF NOT EXISTS bids_auction_idx             ON bids (auction_id);
CREATE INDEX IF NOT EXISTS seller_profiles_user_idx     ON seller_profiles (user_id);
```

Foi aplicada por SQL explícito, e não por `drizzle-kit push`, justamente porque
o `push` compara o schema inteiro e pode propor mudanças destrutivas por causa
de drift acumulado. Até a cadeia de migrations existir, essa é a forma segura de
aplicar uma alteração pontual em produção.

## Scripts administrativos do backend

### Alterações/backfills

- `add-auction-pause-columns.ts`;
- `add-listing-sku.ts`;
- `add-listing-stock.ts`;
- `add-seller-avatar-url.ts`;
- `add-shipping-label-columns.ts`;
- `add-user-phone.ts`;
- `backfill-address-leilao.ts`;
- `backfill-nomes-vazios.ts`;
- `backfill-shipping-dimensions.ts`;
- `src/database/backfill-auctions.ts`;
- `src/database/backfill-user-names.ts`;
- `src/database/ensure-cpf-column.ts`;
- `src/database/ensure-listing-dimensions.ts`;
- `src/database/start-auction-clocks.ts`.

### Auditoria/reparo

- `audit-listings-conformity.ts`;
- `auditar-ativos.ts`;
- `gerar-reprovacoes.ts`;
- `inspecionar-order-pagarme.ts`;
- `limpar-fila-importacao.ts`;
- `cancelar-pedido-pendente.ts`;
- `pausar-leiloes.ts`;
- `reset-auto-founders.ts`;
- `src/database/list-listings.ts`;
- `src/database/merge-daniel-cleanup-placeholders.ts`;
- `src/database/reset-categories.ts`.

### Identidade/seed

- `definir-role.ts`;
- `set-user-phone.ts`;
- `src/database/bootstrap-admin.ts`;
- `src/database/make-admin.ts`;
- `src/database/seed-dev.ts`;
- `src/database/seed-founder-invites.ts`;
- `src/database/backfill-user-avatars.ts` — copia a foto do Clerk para `users.avatar_url` de quem já estava cadastrado antes de o webhook passar a fazer isso. Dry-run por padrão, `--apply` grava. Só considera foto real (`has_image: true`); o avatar de iniciais gerado pelo Clerk é descartado.

Os dois scripts que leem o Clerk (`backfill-user-names.ts` e
`backfill-user-avatars.ts`) precisam rodar com a **mesma instância** que emitiu
os JWTs dos usuários. Com `sk_test_` apontando para o banco de produção nenhum
id casa e o script termina sem fazer nada — o resumo do dry-run mostra isso como
"sem correspondente no Clerk".

### Integração

- `test-recipient-sandbox.ts`.

Trate qualquer script que altere banco como operação destrutiva: leia o código, confirme ambiente e alvo, execute dry-run quando disponível e capture o resultado.

## Deploy do backend

`render.yaml` declara:

- serviço web Node;
- região Ohio;
- plano free;
- `npm install --include=dev && npx nest build`;
- `npm run start:prod`;
- `PORT=3000`;
- `NODE_ENV=production`;
- Turso e Clerk como secrets.

Esse arquivo não enumera todas as integrações atuais. Pagar.me, Melhor Envio, R2, Resend, Bling, flags e URLs precisam ser configurados diretamente no ambiente Render ou adicionados ao manifest.

Checklist:

- `NODE_ENV=production`;
- CORS contém o domínio real;
- Turso aponta para a base correta;
- webhook URLs públicas estão cadastradas;
- secrets não têm espaços/quebras;
- `PAGARME_PLATFORM_RECIPIENT_ID` configurado se split externo estiver ativo;
- flags de cartão iguais no front/back;
- token e saldo Melhor Envio verificados;
- domínio R2 e remetente Resend validados;
- logs de primeiro boot sem mock de auth/frete.

## Deploy do frontend

`vercel.json` reescreve todos os paths para `index.html`.

Checklist:

- `VITE_API_URL` aponta para HTTPS do backend;
- Clerk usa chave live no escopo Production;
- Pagar.me usa chave pública do mesmo ambiente do backend;
- flag de cartão está coerente;
- `VITE_LAUNCH_DATE` está correta e com offset;
- build sem secrets privados;
- rotas profundas abrem diretamente;
- CORS do backend aceita o domínio.

## Webhooks em produção

Cadastre:

- Clerk: `POST /api/webhooks/clerk`;
- Pagar.me: `POST /api/webhooks/pagarme`;
- Stripe legado: `POST /api/webhooks/stripe`;
- Stripe thin: `POST /api/webhooks/stripe-v2`.

Requisitos:

- HTTPS;
- corpo bruto preservado;
- credencial/secret corretos;
- retry do provedor;
- idempotência verificada;
- alertas para eventos `failed`.

## Monitoramento mínimo

O código usa logs do Nest e `email_log`/`webhook_events`, mas não mostra uma plataforma dedicada de observabilidade.

Monitore:

- erros 5xx por endpoint;
- duração de `/api/listings`, checkout, cotação e admin;
- webhook `failed`/`pending` envelhecido;
- pedido `pending` ou `pending_payment` além do prazo;
- etiqueta `failed`;
- saque `processing` antigo;
- leilão ativo com `endsAt` passado;
- saldo/ledger inconsistente;
- erro de e-mail;
- refresh Bling;
- tamanho do bundle frontend.

Nunca registre CPF, documento KYC, token OAuth, secret, card token ou payload bancário completo.

## Backup e recuperação

Antes de mudanças:

- snapshot/backup Turso;
- export das variáveis sem expor valores no ticket;
- registro do commit do front e back;
- inventário de webhooks;
- plano de rollback de schema e deploy.

Campos financeiros e ledger não devem ser “corrigidos” com update manual sem uma transação compensatória e trilha de auditoria.

