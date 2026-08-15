# Frontend: arquitetura, rotas e funcionalidades

## Resumo

`kolecta-the-collector-s-hub` é uma SPA React 18 em TypeScript construída com Vite 5. Possui 65 rotas, autenticação Clerk, cache de servidor com React Query, componentes Radix/shadcn, Tailwind e áreas completas de marketplace, leilão, conta, vendedor, comunidade e administração.

## Stack

| Responsabilidade | Tecnologia |
|---|---|
| UI/runtime | React 18, React DOM |
| Build/dev | Vite 5 + SWC |
| Linguagem | TypeScript 5.8 |
| Rotas | React Router 6 |
| Dados remotos | TanStack React Query 5 |
| Formulários | React Hook Form + Zod |
| Design system | Tailwind, Radix UI, shadcn, CVA |
| Ícones/animação | Lucide, Framer Motion |
| Gráficos | Recharts |
| Autenticação | Clerk React |
| Pagamento | Stripe JS legado; tokenização Pagar.me |
| Analytics | Vercel Analytics e Meta Pixel |
| Unit/component | Vitest, Testing Library, jsdom |
| E2E | Playwright |

## Inicialização e providers

`src/main.tsx`:

- cria o root React;
- instala `ClerkProvider` em pt-BR quando há publishable key;
- configura tema Clerk e redirects pós-login/cadastro/logout;
- entra em modo degradado público quando a chave não existe.

`src/App.tsx` empilha:

1. `QueryClientProvider`;
2. `AuthProvider`;
3. `CartProvider`;
4. `TooltipProvider`;
5. toasts;
6. `BrowserRouter`;
7. analytics, pixel, consentimento e ferramentas de dev;
8. `LaunchGate`;
9. `ErrorBoundary`;
10. rotas.

## Estrutura

```text
src/
├── main.tsx
├── App.tsx
├── pages/
│   ├── auth/
│   ├── account/
│   ├── seller/
│   └── admin/
├── components/
│   ├── layout/
│   ├── checkout/
│   └── ui/
├── contexts/
│   ├── AuthContext.tsx
│   └── CartContext.tsx
├── hooks/
│   ├── use-api.ts
│   └── use-launch-gate.ts
├── lib/
│   ├── api.ts
│   └── regras e adaptadores de domínio
└── test/
```

Segundo o Graphify, `api.ts`, `use-api.ts` e `App.tsx` são os maiores hubs. Alterações de contrato devem mantê-los sincronizados.

## Camada HTTP

`src/lib/api.ts` concentra:

- `BASE_URL`, vindo de `VITE_API_URL` ou fallback local;
- obtenção de token Clerk por callback configurado;
- Bearer token;
- `Content-Type`;
- `x-dev-user-id` em desenvolvimento;
- parsing de resposta e erro;
- tipos TypeScript;
- clients agrupados por domínio.

Uploads de planilha e imagem usam `fetch` diretamente para não forçar JSON. Download de etiqueta também usa `fetch` para tratar blob.

O token provider é ligado pelos hooks; telas devem preferir `use-api.ts` em vez de chamar o client diretamente.

## React Query

`src/hooks/use-api.ts` contém hooks para:

- perfil e fundador;
- loja/políticas;
- catálogo, anúncio, CRUD, publicação e importação;
- wallet, depósito e saques;
- compras, vendas, detalhe, entrega, cancelamento e checkout;
- avaliações e disputas;
- favoritos, endereços e cartão;
- recebedor e Connect legado;
- leilões e lances;
- estatísticas/admin;
- mensagens;
- Bling;
- upload;
- comunidade.

Mutações invalidam queries relacionadas. Ao criar ou moderar anúncio, por exemplo, é necessário invalidar catálogo, meus anúncios e filas admin. Ao alterar pedido, compras, vendas, wallet e detalhe podem precisar de invalidação conjunta.

O `QueryClient` usa defaults da biblioteca; não há política global personalizada de retry/stale time no `App.tsx`.

## Autenticação e autorização visual

`AuthProvider` combina:

- sessão/identidade do Clerk;
- perfil do backend para `role`;
- avatar e e-mail do Clerk;
- nome com fallback para backend.

Sem Clerk, o app público renderiza, mas `isAuthenticated=false`.

`ProtectedRoute`:

- mostra spinner enquanto autenticação/perfil carregam;
- envia não autenticado para `/entrar`, preservando `returnTo`;
- envia role insuficiente para `/`;
- aceita `role="admin"`.

Essa proteção melhora UX, mas não substitui os guards do backend.

## Gate de lançamento

`VITE_LAUNCH_DATE` define a data ISO com timezone. Sem valor válido, o site é considerado aberto.

Antes do lançamento, para não-admin:

- `/` mostra a experiência de countdown;
- ficam abertas autenticação, conta, painel do vendedor e páginas institucionais;
- marketplace, produto, leilão, comunidade, categorias, checkout e admin ficam fechados por padrão;
- novas rotas também ficam fechadas até entrarem na allowlist;
- a decisão é recalculada a cada 30 segundos, permitindo abrir uma aba já carregada sem refresh;
- admin ignora o gate.

## Catálogo e representação de anúncio

O backend devolve `images` e `attributes` como JSON stringificado. Helpers do frontend:

- convertem fotos com tolerância a formato legado;
- formatam descrição e condição;
- expõem atributos por categoria;
- avaliam visibilidade;
- calculam destaque por `featuredUntil`;
- mapeiam listing para produto visual.

O cache `kolecta:catalogo:v1`:

- guarda a última lista no `localStorage`;
- vence em 24 horas;
- não grava acima de 2 MiB;
- serve como `initialData`, enquanto a API revalida.

Preço/estoque exibidos pelo cache podem estar defasados; checkout sempre depende da validação do backend.

O cache existe porque o frontend baixa o catálogo inteiro e filtra categoria,
preço, condição e busca no navegador (`LIMITE_CATALOGO`, `lib/busca.ts`). Desde
27/07/2026 o backend faz todos esses filtros em SQL e devolve `meta` com
`total`/`totalPages` — ver a
[referência da API](./03-api-backend.md#get-apilistings--filtros-da-vitrine).
O frontend ainda não foi religado a eles: continua baixando ~1 MB por visita
onde a página de categoria pediria ~40 KB. Migrar cada tela para pedir só o que
mostra torna esse cache, e o teto de catálogo, desnecessários.

## Carrinho e checkout

`CartContext` persiste em `kolecta_cart`. A quantidade máxima atual é 1 porque o contrato de checkout envia apenas `listingId`, sem quantidade.

Checkout:

- exige autenticação;
- aceita endereço salvo ou digitado;
- consulta ViaCEP no navegador;
- cota frete pelo backend;
- permite retirada quando oferecida pela interface;
- permite PIX;
- permite cartão quando feature flag e configuração Pagar.me estão ativas;
- tokeniza cartão diretamente no endpoint público Pagar.me;
- solicita simulação de parcelas ao backend;
- envia CPF e telefone;
- redireciona para confirmação, que acompanha estado pendente.

O controle “usar saldo” foi removido em 31/07. Todo checkout novo cobra o valor
integral no gateway; a wallet continua visível em conta/financeiro para saldo,
depósito e saque. As telas de depósito ainda não foram adequadas a essa mudança.

O frontend não deve calcular o total final como autoridade. `order-breakdown.ts` serve à apresentação; o backend recalcula.

## Leilões

Páginas:

- vitrine do Modo Lance;
- detalhe, countdown, histórico e lance;
- meus lances;
- gerenciador do vendedor;
- monitor admin.

O frontend:

- distingue lance atual/inicial;
- apresenta status de liderança e resultado;
- respeita pausa;
- mostra anti-sniper e tempo;
- exige cartão salvo para lances;
- permite pagamento de arremate pendente;
- oferece encerramento ao vendedor quando autorizado.

O tempo e o estado definitivos vêm da API; countdown local é apenas apresentação.

## Criação, edição e importação de anúncios

O wizard de criação cobre:

- venda direta ou leilão;
- categoria e campos específicos;
- condição;
- detalhes comerciais;
- SKU/estoque;
- descrição;
- fotos;
- preço ou parâmetros de leilão;
- peso/dimensões.

Rascunho:

- chave `kolecta:listing-draft`;
- persiste etapa e formulário;
- permite retomar;
- também é usado para duplicação;
- duplicar não copia SKU nem fotos, reduzindo risco de estoque/imagem incorretos.

Após salvar, o anúncio pode ser enviado à moderação. Motivos de reprovação ficam visíveis para correção.

Importação em lote aceita CSV/XLSX, oferece template, inicia job e faz polling do progresso/erros.

## Comunidade

A página integra:

- feed;
- destaques e tendências;
- filtros de tipo;
- criação de post;
- post de produto ligado a listing;
- like/save/pin;
- comentários;
- denúncia.

Imagens de posts usam enquadramento padronizado no feed e abrem em visualização
ampliada ao clicar.

O client expõe leitura pública e exige token nas interações. A moderação da comunidade existe no backend, mas não há uma rota/página admin dedicada importada no `App.tsx` analisado.

## Áreas funcionais

### Público

- home;
- carrinho e checkout;
- busca;
- produto;
- leilões;
- comunidade;
- categorias;
- perfil do vendedor;
- autenticação;
- páginas institucionais/ajuda.

### Conta do comprador

- dashboard;
- pedidos e detalhe;
- lances;
- favoritos;
- endereços;
- pagamentos/cartão;
- verificação;
- mensagens;
- avaliações;
- disputas.

### Painel do vendedor

- dashboard;
- anúncios;
- criação/edição/importação;
- pedidos e detalhe;
- Modo Lance;
- integrações;
- financeiro;
- recebedor/KYC;
- mensagens;
- configurações/políticas;
- mídia.

### Admin

- overview;
- usuários/roles;
- verificação de vendedores;
- fundadores;
- moderação de anúncios;
- detalhe do anúncio;
- monitor de leilões;
- disputas;
- comissões/taxas;
- financeiro;
- mídia;
- analytics;
- relatórios;
- configurações.

Algumas telas de configurações/mídia comunicam funcionalidades ainda não suportadas por backend, conforme registrado em [Estado e riscos](./07-estado-riscos.md).

## Catálogo de rotas

### Públicas no roteador

| Path | Tela |
|---|---|
| `/` | home ou countdown |
| `/fundadores` | landing permanente do programa fundador |
| `/carrinho` | carrinho |
| `/checkout` | checkout |
| `/pedido/confirmacao` | confirmação/acompanhamento |
| `/busca` | busca |
| `/produto/:id` | detalhe do produto |
| `/modo-lance` | vitrine de leilões |
| `/modo-lance/:id` | detalhe do leilão |
| `/comunidade` | comunidade |
| `/categorias` | categorias |
| `/categoria/:slug` | vitrine da categoria |
| `/entrar/*` | login Clerk |
| `/criar-conta/*` | cadastro Clerk + consentimento |
| `/esqueci-senha` | recuperação |
| `/vendedor/:slug` | perfil público |
| `/como-funciona` | institucional |
| `/taxas-e-comissoes` | institucional |
| `/seguranca` | institucional |
| `/ajuda` | central de ajuda |
| `/ajuda/:slug` | artigo |
| `/termos` | termos |
| `/privacidade` | privacidade |
| `/connect/success` | callback visual Stripe legado |
| `/connect/refresh` | redireciona para `/painel/recebedor` |

“Pública no roteador” não significa aberta no pré-lançamento; o `LaunchGate` pode redirecionar.

### Conta autenticada

| Path | Tela |
|---|---|
| `/conta` | dashboard |
| `/conta/pedidos` | compras |
| `/conta/pedidos/:id` | detalhe |
| `/conta/lances` | meus lances |
| `/conta/favoritos` | favoritos |
| `/conta/enderecos` | endereços |
| `/conta/pagamentos` | cartão/pagamentos |
| `/conta/verificacao` | verificação |
| `/conta/mensagens` | mensagens |
| `/conta/avaliacoes` | avaliações |
| `/conta/disputas` | disputas |

### Vendedor autenticado

| Path | Tela |
|---|---|
| `/painel` | dashboard |
| `/painel/anuncios` | anúncios |
| `/painel/anuncios/novo` | criação |
| `/painel/anuncios/:id/editar` | edição |
| `/painel/pedidos` | vendas |
| `/painel/pedidos/:id` | detalhe da venda |
| `/painel/modo-lance` | gerenciador de leilões |
| `/painel/integracoes` | Bling e integrações |
| `/painel/financeiro` | wallet/saques |
| `/painel/stripe-onboarding` | redirect para recebedor |
| `/painel/recebedor` | onboarding/KYC Pagar.me |
| `/painel/mensagens` | mensagens |
| `/painel/configuracoes` | perfil/políticas/preferências |
| `/painel/midia` | mídia/destaques |
| `/painel/importar` | importação |

### Admin

| Path | Tela |
|---|---|
| `/admin` | overview |
| `/admin/usuarios` | usuários/roles |
| `/admin/vendedores/verificacao` | verificação |
| `/admin/fundadores` | fundadores |
| `/admin/anuncios` | moderação |
| `/admin/anuncios/:id` | detalhe |
| `/admin/modo-lance` | monitor |
| `/admin/disputas` | disputas |
| `/admin/comissoes-e-taxas` | configuração visual de taxas |
| `/admin/financeiro` | financeiro |
| `/admin/midia` | mídia |
| `/admin/analytics` | analytics |
| `/admin/relatorios` | relatórios |
| `/admin/configuracoes` | configurações |
| `*` | 404 |

## Estado local persistente

| Chave/padrão | Conteúdo |
|---|---|
| `kolecta_cart` | carrinho |
| `kolecta:listing-draft` | rascunho/duplicação |
| `kolecta:catalogo:v1` | cache de catálogo |
| `kolecta_legal_consent` | aceite local |
| `kolecta_legal_consent_synced` | sincronização concluída |
| `kolecta_aviso_visto:<userId>` | campanha de pagamento confirmada pela conta |
| `dev_user_id` | usuário selecionado em desenvolvimento |
| `report_<listingId>` | anúncio já denunciado neste navegador |
| chave do Meta Pixel | signup já contado |

Nenhum desses dados substitui estado do servidor.

## Componentes e utilitários transversais

- layouts público, vendedor e admin;
- `ErrorBoundary` contra tela branca;
- `ScrollToTop`;
- `LoadingSkeleton` e `EmptyState`;
- `ProductCard`, galeria e descrição;
- timeline de status;
- modal de disputa e denúncia;
- badges de verificação/fundador;
- componentes de leilão;
- editor de campos de categoria;
- cart drawer;
- modal temporário e bloqueante de aviso sobre meios de pagamento, exibido uma vez por conta/campanha;
- componentes Radix/shadcn em `components/ui`.

Bibliotecas de domínio em `src/lib` cobrem moeda, CPF, frete, taxas, busca, catálogo, condições, fotos, leilão, visibilidade, analytics e regras da home.

## Testes

Estado verificado:

- 44 arquivos Vitest;
- 443 testes passando;
- build Vite concluído.

Cobertura visível:

- regras de catálogo, busca, categorias, condição e fotos;
- criação/importação de anúncio e moderação admin;
- leilões e meus lances;
- checkout/frete;
- comunidade;
- fundadores e launch gate;
- analytics/Meta Pixel;
- componentes de produto, header e avisos;
- hooks.

Playwright possui cenários para favoritos, depósito e checkout. Eles exigem ambiente navegável e não foram executados nesta fotografia.

## Build e entrega

- desenvolvimento: porta 8080, host IPv6 `::`;
- alias `@` aponta para `src`;
- Vercel reescreve qualquer path para `index.html`, habilitando rotas SPA;
- output em `dist`;
- Vercel Analytics é carregado dentro da aplicação.
- bundle JS atual: 1.886,15 kB minificado e 511,61 kB gzip; o build mantém o aviso de chunk acima de 500 kB.
