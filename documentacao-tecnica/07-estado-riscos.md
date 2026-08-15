# Estado verificado, riscos e divergências

## Resumo executivo

O código compila e os testes unitários/componentes passam. Os fluxos centrais estão implementados, mas o sistema está em uma transição real de Stripe para Pagar.me e ainda apresenta contratos mortos, textos defasados, ausência de migrations versionadas e alguns pontos de segurança/operabilidade que merecem prioridade antes de escalar tráfego financeiro.

Classificação:

- **P0**: risco imediato de segurança/perda financeira;
- **P1**: alta prioridade antes de produção/escala;
- **P2**: dívida que pode causar erro, manutenção cara ou UX inconsistente;
- **P3**: melhoria técnica.

## Verificações executadas

| Item | Resultado |
|---|---|
| Backend `npm test` | 48/48 suítes, 559/559 testes |
| Backend `npm run build` | passou |
| Frontend `npm test` | 69/69 arquivos, 879/879 testes |
| Frontend `npm run build` | passou |
| E2E Nest | 3/3 suítes, 23/23 testes (consertado em 06/08, estava 15/23 vermelho) |
| E2E Playwright | não executado |

Os logs “ERROR” vistos em testes de Pagar.me, saque, frete e leilão pertencem a cenários de falha simulados que passaram.

## P0 — Depósito continua aberto, mas saldo não compra

Em 31/07 o checkout deixou corretamente de aceitar saldo da wallet, pois esse
caminho não passava pelo split Pagar.me. Porém continuam ativos:

- `POST /api/wallet/deposit`;
- “Adicionar saldo” em `/conta/pagamentos` e `/painel/financeiro`;
- o texto “Compras usam saldo da carteira” na conta do comprador.

O saldo depositado não pode mais ser gasto. Saque exige perfil de vendedor com
recebedor Pagar.me e `canWithdraw`, portanto um comprador comum pode enviar PIX
para a wallet e ficar sem caminho de saída pela interface/API.

Recomendação: desabilitar imediatamente depósito no backend e nas duas telas,
ou implementar estorno/saque de comprador antes de reabri-lo. Auditar saldos
originados por `deposit` desde a mudança e contatar/reembolsar afetados.

## P1 — Segurança e dinheiro

### Rotas Connect legadas sem `AuthGuard`

`src/connect/connect.controller.ts` lê `req.auth?.userId`, mas não declara `@UseGuards(AuthGuard)`. Em produção, o middleware Clerk pode disponibilizar estado, porém o controller:

- não força a autenticação pelo mecanismo padrão;
- lança `Error` genérico quando não há ID, podendo virar 500;
- não passa pelo mesmo caminho de validação usado no resto da API.

Recomendação: adicionar `AuthGuard` na classe, usar exceção 401/403 apropriada e manter o módulo somente se o legado Stripe ainda for necessário.

### OAuth Bling usa `state` como ID de usuário

O fluxo coloca `userId` diretamente em `state` e o callback público o usa para persistir tokens. Não foi encontrado nonce, assinatura ou armazenamento server-side do state.

Risco: CSRF/confusão de vínculo OAuth.

Recomendação: gerar state aleatório, armazenar hash + userId + expiração no servidor, consumir uma única vez e validar antes da troca do code.

### Split agora falha fechado, mas não possui health check de prontidão

O fallback silencioso foi removido: compra, lance, reauth e pagamento pendente
são recusados quando falta recebedor ativo do vendedor ou
`PAGARME_PLATFORM_RECIPIENT_ID`. Isso elimina a cobrança sem divisão, mas uma
variável ausente só é descoberta na tentativa do usuário e pode derrubar todas
as vendas/leilões.

Recomendação: validar a configuração no boot ou num readiness check financeiro,
alertar antes de publicar e expor uma capability segura para o frontend.

### Frete do checkout é confiado ao cliente

O backend relê o preço do item, mas usa diretamente `shippingInCents`,
`shippingServiceId` e nome enviados pelo navegador. Não há quote ID assinado,
reconsulta do Melhor Envio ou verificação de que preço e serviço pertencem à
mesma cotação. Um cliente modificado pode enviar frete zero e a Kolecta ainda
precisar comprar a etiqueta.

Recomendação: persistir/assinar a cotação no backend, receber apenas seu ID no
checkout e recalcular total/split a partir desse registro.

### Espelho da taxa Pagar.me ainda não concilia o custo real

Compra e leilão agora compartilham percentuais de PIX/cartão e aceitam vírgula
decimal, mas as variáveis têm default 0 e o cálculo omite os custos fixos do
contrato (gateway R$ 0,55 + antifraude R$ 0,44). Como a Pagar.me desconta a taxa
real do recebedor e a wallet guarda apenas uma estimativa, o vendedor pode ver
saldo maior que o disponível e ter saque recusado.

> **Aconteceu exatamente isso em 13/08/2026** — por outra taxa, a de saque, que
> nem estava modelada. A previsão desta seção estava certa e ficou parada.
> Tratar o resto dela como risco ativo, não como hipótese.

Estado por instrumento, medido no pedido `0f9d3653`:

- **PIX confere.** A cobrança foi 1,09% × R$ 206,83 = R$ 2,25, e o espelho
  bateu no centavo — provavelmente porque gateway e antifraude são custos de
  cartão. Atenção: a tabela de preços em imagem mostra 1,19% e 3,99%, mas as
  "Condições acordadas" da conta nova dizem 1,09% e 3,89%, e foi 1,09% que a
  Pagar.me cobrou. Não "corrigir" as env pelos números da imagem.
- **Cartão não foi conferido** contra o extrato. Se lá saírem os R$ 0,99 fixos,
  são ~R$ 0,99 de desvio por venda — mesma classe de erro da taxa de saque, num
  lugar bem mais movimentado.

Recomendação: tornar percentuais obrigatórios em produção, conferir um pedido
pago no cartão contra o extrato do recebedor, e reconciliar pela operação de
saldo/taxa real da Pagar.me, incluindo valores fixos.

### ~~Saque quebrado para TODOS os vendedores~~ — a taxa de saque nunca foi debitada

> **Revisado em 13/08/2026.** Esta seção afirmava que `POST /transfers` respondia
> 401 em toda chamada e que nenhum vendedor sacava desde 31/07. **É falso desde
> 10/08**: dois transfers foram criados pela API e **concluídos**, com dinheiro
> na conta do vendedor (`539696597`, R$ 870,00; `539709738`, R$ 216,95). A causa
> real das falhas seguintes era outra, e nossa.

A Pagar.me cobra **R$ 3,67 fixos por saque** ("Taxa de saque" nas condições da
conta), debitados do saldo do recebedor junto com o principal. A carteira
debitava **só o principal**, então ficava R$ 3,67 acima da realidade a cada
saque e o erro acumulava. Consequência: **"sacar tudo" nunca funcionou para
ninguém** — o último saque sempre pedia mais do que existia na Pagar.me.

Em 13/08 um vendedor tentou três vezes numa noite e parou a R$ 2,90 de
conseguir: a carteira dizia R$ 175,11, o recebedor tinha R$ 167,77, e a
diferença era exatamente 2 × R$ 3,67 dos dois saques que ele já tinha feito.

**Por que só apareceu agora:** a retenção de 48h vinha cobrindo a taxa sem
ninguém notar. O dinheiro que a carteira segura como retido **já está disponível
no recebedor** — a retenção é regra nossa, não deles —, então o saldo real era
sempre maior que o disponível interno. Quando a retenção zerou, o buraco
apareceu. Daí a invariante correta ser `disponível + retido == saldo do
recebedor`, e não a igualdade com o disponível.

O estorno interno protege o saldo — verificado em todas as falhas, com débito e
crédito no mesmo segundo e nenhum centavo perdido.

**Corrigido em 13/08:** carteira debita valor + taxa; `GET
/api/withdrawals/limits` expõe o máximo real (`min(carteira, saldo do recebedor)
− taxa`); a interface mostra a quebra de valores e um botão "Sacar tudo" no
valor que funciona; e `failure_reason` passou a gravar o motivo real em vez da
string fixa — antes disso, diagnosticar exigia o extrato da Pagar.me na mão.

Aberto: corrigir o desvio histórico de R$ 7,34 do vendedor afetado e decidir se
a Kolecta absorve o retroativo. Ver `docs/PLAN-taxa-de-saque.md`.

⚠️ O `docs/CHAMADO-pagarme-transfers-401.md` **continua com o diagnóstico
antigo**. Não cobrar o suporte por esse bloqueio sem antes perguntar se houve
liberação entre 06/08 e 10/08 — as transferências concluídas desmentem o texto,
e insistir nele enfraquece o resto da conversa.

### Nenhum webhook `transfer.*` jamais chegou

A tabela `webhook_events` está vazia para o tipo desde sempre, embora
`pagarme-webhook.controller.ts` já trate os seis eventos de transferência e a
mesma URL receba `order.*`, `charge.*` e `recipient.*` normalmente.

Sem esse aviso **nenhum saque sai de `processing`** — nem para `paid`, nem para
`failed`. Hoje há **4 saques presos**, R$ 1.302,05, sendo pelo menos dois já
pagos de fato.

Some-se um problema nosso: `pagarme_transfer_id` foi gravado como número
(`539696597.0`, REAL no SQLite) e o lookup do webhook compara com a string do
payload — mesmo que o evento passe a chegar, não casaria, e falharia em
silêncio.

Recomendação: normalizar o id para texto (gravação, lookup e backfill) **antes**
de testar o webhook, e confirmar com a Pagar.me se os eventos estão assinados.
Perguntas prontas em `docs/PENDENCIA-pagarme-webhook-transferencia.md`.

### Feature flags duplicadas de cartão

Backend exige `PAGAMENTO_CARTAO_HABILITADO=true`; frontend exige `VITE_CARTAO_HABILITADO=true`. Divergência gera:

- UI oferecendo cartão que o backend recusa; ou
- backend aberto sem UI oficial.

Recomendação: endpoint público de capabilities/config segura, consumido pelo frontend, mantendo o backend como autoridade.

### Sem rate limiting/headers de segurança explícitos

Não foram encontrados `@nestjs/throttler`, Helmet ou proteção equivalente no código/dependências analisados. Endpoints sensíveis incluem login indireto, checkout, lance, uploads, mensagens, denúncias e webhooks.

Recomendação: aplicar rate limiting por IP/usuário/rota, limites de payload/upload, Helmet e proteção específica de abuso.

### Tokens OAuth Bling em texto na base

`bling_connections` persiste access/refresh token. Não há criptografia de aplicação visível.

Recomendação: criptografar com chave gerenciada fora do banco, limitar leitura e criar rotação/revogação.

## P1 — Banco e operação

### Migrações não estão versionadas como cadeia única

O schema atual é centralizado, mas mudanças históricas aparecem em scripts avulsos `add-*`, `ensure-*` e `backfill-*`. Não há diretório Drizzle de migrations visível no estado analisado.

Riscos:

- ambientes com schemas diferentes;
- script repetido;
- deploy de código antes da coluna;
- rollback difícil.

O terceiro risco não é hipotético: já derrubou `/api/listings` inteiro uma vez
(coluna presente no `schema.ts` e ausente no banco). Em 27/07 a coluna
`users.avatar_url` e seis índices foram aplicados manualmente em produção
**antes** do deploy do código que os usa, exatamente para não repetir o
incidente — o que confirma que a ordem hoje depende de disciplina humana, não da
ferramenta.

Recomendação: estabelecer baseline do banco atual, adotar migrations incrementais versionadas, registrar tabela de migrations e transformar backfills em operações idempotentes auditáveis.

### Cron sem lock distribuído visível

Com uma instância Render, funciona. Com duas ou mais réplicas, cada uma executaria encerramento de leilão, reauth, expiração, liberação, ranking e manutenção.

Recomendação: lock/lease no banco, fila única ou worker dedicado. Preserve idempotência no service como segunda defesa.

### Restrições de integridade ausentes

O banco não impede diretamente:

- múltiplos seller profiles por usuário;
- múltiplos leilões por listing;
- favorito duplicado;
- conversa duplicada;
- avaliações duplicadas;
- mais de um endereço padrão.

Recomendação: auditar dados, corrigir duplicados e adicionar índices/restrições onde a regra for definitiva.

## P1/P2 — Contratos frontend/backend

### Client morto de depósito Stripe

O frontend ainda define:

```text
POST /api/deposits/checkout-session
```

em `src/lib/api.ts` e `useDeposit()` em `src/hooks/use-api.ts`. O backend não possui esse controller/path; o depósito atual é:

```text
POST /api/wallet/deposit
```

Há também `useWalletDeposit()`, que usa o caminho atual. Não foi encontrado uso de `useDeposit()` em páginas.

Recomendação: remover client/hook morto e qualquer teste E2E legado que espere checkout session Stripe, ou reescrever para PIX wallet.

### Comentário de estoque está defasado

`CreateListingPayload.stock` no frontend afirma que o backend não grava estoque. No código atual:

- DTO aceita `stock`;
- schema possui `stock`;
- create/update persistem;
- testes cobrem o comportamento.

Recomendação: corrigir o comentário para não induzir futuras remoções ou workarounds.

### Tipo de status de pedido incompleto/divergente

O schema/service usa ou menciona estados como `refunded` e chargeback, enquanto `OrderStatus` do frontend lista `processing` e `disputed`, mas não `refunded`. Como o banco usa texto, novos estados chegam sem proteção estática.

Recomendação: declarar vocabulário canônico compartilhado, mapear estado desconhecido com fallback visual e adicionar testes de contrato.

### Semântica dupla de `paymentMethod`

No DTO de checkout:

- `paymentMethod = pix|credit_card`.

Na tabela, por legado:

- `paymentMethod = wallet|external|hybrid`;
- `paymentInstrument = pix|credit_card`.

Recomendação: renomear gradualmente o campo de entrada para `paymentInstrument`, mantendo compatibilidade temporária.

Novos checkouts gravam apenas composição externa; `wallet|hybrid` sobrevivem em
linhas antigas e ramos mortos do service.

### Rota de perfil chama parâmetro de slug, mas usa ID

Frontend declara `/vendedor/:slug`, porém a tela comenta que o valor é user ID e o backend consulta `users.id`. Funciona, mas a URL não é um slug legível.

Recomendação: renomear para `:id` ou implementar slug persistente/único com redirect e compatibilidade.

### Quantidade e estoque ainda não se encontram no checkout

Parcialmente resolvido em 27/07/2026. A regra de decremento existe: a confirmação
do pagamento baixa uma unidade atomicamente no banco e pausa o anúncio ao zerar.

O que continua aberto é a outra metade: o carrinho ainda limita a quantidade a 1
e o DTO envia apenas `listingId`, então ninguém compra duas unidades de uma vez.

Recomendação: adicionar `quantity` ao DTO e ao carrinho, fazer a baixa usar essa
quantidade (`stock - :qtd WHERE stock >= :qtd`) e definir a reversão em
cancelamento e chargeback, que hoje não devolve unidade ao estoque.

### Aba "Vendidos" do vendedor não vê o anúncio que zerou o estoque

`seller/Listings.tsx` monta a aba "Vendidos" filtrando `status = 'sold'`. Desde
27/07, anúncio **com estoque informado** que zera vai para `paused`, e não
`sold` — escolha deliberada, porque de `paused` o vendedor repõe e reativa sem
recriar o anúncio. Anúncio sem estoque informado continua indo para `sold`.

Efeito: um anúncio esgotado aparece em "Pausados". A venda continua no histórico
de pedidos, então nada se perde, mas a aba deixa de responder à pergunta que o
vendedor faz.

Recomendação: a aba passar a olhar os pedidos do vendedor em vez do status do
anúncio.

### Fotos de perfil antigas ainda não foram copiadas do Clerk

O webhook copia a `image_url` do Clerk para `users.avatar_url` no cadastro e na
atualização do usuário, o que só cobre quem se cadastrar ou mexer no perfil
daqui em diante. `src/database/backfill-user-avatars.ts` resolve o passado, mas
depende de rodar com a `CLERK_SECRET_KEY` **live**: com a chave de teste do
`.env` local contra o banco de produção, nenhum id casa e o script não faz nada
(comportamento correto, e o dry-run mostra isso).

Recomendação: rodar o backfill com a chave live, a mesma que emitiu os JWTs dos
usuários. Vale para o `backfill-user-names.ts` pelo mesmo motivo.

## P2 — Migração e funcionalidades parciais

### Stripe e Pagar.me coexistem

Ainda existem:

- módulos, webhooks, colunas e Connect Stripe;
- página/callback visual legado;
- tipos e textos Stripe;
- Pagar.me como caminho principal.

Recomendação: criar inventário de dados/eventos Stripe ativos, data de corte e sequência de remoção. Não apagar colunas antes de reconciliar pedidos, depósitos, saques e contas.

### Simulador admin de taxas está defasado

`pages/admin/CommissionsAndFees.tsx` calcula processamento como Stripe ~4%, enquanto o backend:

- usa Pagar.me;
- tem gateway/card fees configuráveis com default 0 para bookkeeping;
- usa tabela CET específica para parcelamento.

A tela é simulador local e não lê configuração real.

Recomendação: endpoint admin somente leitura com configuração efetiva segura e cálculo executado pelo mesmo domínio do checkout.

### Receita admin depende de heurística para pedidos históricos

O painel deixou corretamente de contar frete como comissão e expõe o trânsito
de frete separadamente. Para distinguir a semântica antiga e nova de
`platform_fee_in_cents`, porém, usa `fee > shipping`: um pedido antigo de item
caro com frete baixo pode ser classificado como se o frete estivesse embutido e
subestimar receita.

Recomendação: migrar os pedidos para colunas semanticamente estáveis ou marcar
explicitamente a versão da regra financeira; depois remover a heurística.

### Broadcast roda dentro da requisição e conta tentativas

O broadcast é seguro contra disparo acidental e reenvio de sucessos, mas o loop
é síncrono dentro de `POST /api/admin/broadcast`. Lote grande pode exceder o
timeout do proxy. Além disso, `MailService.send()` não lança em `failed` ou
`skipped`, então `enviados` conta iterações, não mensagens aceitas pela Resend.

Recomendação: operar em lotes curtos e conferir `email_log`; evoluir para job
assíncrono com contadores separados de enviado, falho e ignorado.

### Filtro de frete pode bloquear uma rota atendida

O backend limita a cotação a seis serviços. Quando nenhum deles atende, devolve
lista vazia mesmo que outras transportadoras tenham sido cotadas; hoje existe
apenas log de warning, sem fallback para o comprador.

Recomendação: medir o warning, definir fallback controlado ou permitir serviço
extra por região antes de assumir cobertura nacional.

### Configurações e mídia são principalmente informativas

As telas admin de configurações e mídia deixam claro que:

- não persistem configuração geral;
- não controlam cadastro, leilão, backup ou notificações;
- não há mídia paga/banners/campanhas.

No vendedor, planos Bronze/Prata/Ouro são “em breve”; apenas crédito fundador é real.

Recomendação: manter CTAs desabilitados e não tratar essas telas como funcionalidades entregues.

### Moderação da comunidade sem tela dedicada

O backend oferece fila de denúncias, status e banimentos, mas o `App.tsx` não registra página admin específica da comunidade.

Recomendação: ou construir a UI, ou documentar/operar temporariamente por ferramenta interna segura.

### `render.yaml` não lista integrações atuais

O manifest declara Turso/Clerk, mas não Pagar.me, Melhor Envio, R2, Resend, Bling e flags.

Recomendação: completar infraestrutura como código ou manter checklist auditável no provedor.

## P2 — Performance e UX

### Bundle frontend grande

Build verificado:

- JS minificado: aproximadamente 1.886,15 kB;
- gzip: aproximadamente 511,61 kB;
- Vite alerta por chunk acima de 500 kB.

Todas as páginas são importadas de forma eager em `App.tsx`.

Recomendação: `React.lazy` por áreas pública/conta/vendedor/admin, chunks manuais para Clerk/Radix/gráficos e medição por rota.

### Catálogo depende de cache local para mascarar latência

O cache melhora retorno, mas mantém dado por até 24h. O checkout corrige preço/disponibilidade, porém o usuário pode clicar em item desatualizado.

Recomendação: otimizar consulta/indexes/payload do backend e reduzir o cache a estratégia SWR com timestamp visível ou invalidação melhor.

### Avisos de acessibilidade em dialogs

Testes mostram “Missing Description or aria-describedby” em diálogos de header/disputas.

Recomendação: adicionar `DialogDescription` ou `aria-describedby={undefined}` intencional e testar com axe.

### React Router e Browserslist

Build/testes mostram:

- flags futuras do React Router v7;
- `caniuse-lite` aproximadamente 13 meses defasado.

Recomendação: habilitar/testar future flags antes do upgrade e atualizar Browserslist em PR isolado.

## P3 — Manutenibilidade

### API sem OpenAPI gerado

Há DTOs e controllers, mas não Swagger/OpenAPI. A referência manual pode se desatualizar.

Recomendação: gerar OpenAPI em build/CI e validar compatibilidade com o client.

### Respostas sem envelope consistente

Há `{data}`, objeto direto, `options`, redirects, blobs e respostas do service. O client conhece as diferenças, mas isso aumenta acoplamento.

Recomendação: padronizar novos JSON em `{data, meta?, error?}` sem forçar blobs/webhooks ao mesmo formato.

### Strings de status livres

SQLite recebe texto sem check constraints. Backend e frontend duplicam listas.

Recomendação: constantes compartilhadas ou pacote de contratos gerado; no banco, checks quando a migração for segura.

### Arquivos centrais muito conectados

Graphify aponta:

- backend: schema/app module/orders/auctions/listings;
- frontend: api/use-api/App.

Recomendação: dividir `api.ts` e `use-api.ts` por domínio, lazy-load de rotas e serviços menores em orders/auctions, mantendo testes de integração.

## Próxima sequência recomendada

1. Fechar depósito PIX e tratar qualquer saldo de comprador preso.
2. Autorizar frete somente por cotação criada/validada no backend.
3. Tornar configuração financeira obrigatória e reconciliar taxas reais.
4. Validar saque/allowlist na conta Pagar.me nova.
5. Endurecer Connect e OAuth Bling.
6. Criar baseline e pipeline de migrations.
7. Remover clients/ramos Stripe-wallet mortos e corrigir tipos/textos.
8. Rodar E2E completo em sandbox Pagar.me/Clerk/Melhor Envio.
9. Centralizar capabilities/status/taxas e fazer code splitting.
10. Planejar retirada definitiva do Stripe.
