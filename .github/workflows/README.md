# CI/CD — o que falta fazer no painel

O `ci.yml` roda sozinho a partir do primeiro push. O **deploy gateado** precisa
de dois passos manuais que nao dao para fazer por codigo. Enquanto eles nao
acontecerem, o CI funciona normalmente e o passo de deploy so avisa que o
segredo nao existe — nao falha a rodada.

## Por que isso existe

Em 06/08/2026 o `AnalyticsModule` foi para producao sem importar o `AuthModule`.
O `RolesGuard` que o controller usa injeta `UsersService`, o Nest nao achou o
provider e abortou o bootstrap. Nao quebrou uma rota: derrubou a API inteira, em
crash loop, ate alguem olhar o log.

O `npm run build` do Render nao pegaria: ele compila TypeScript, e o erro e de
injecao, que so aparece quando o Nest monta o grafo. Quem pega e o
`src/app.module.spec.ts` — mas ele so vale se alguem rodar, e ninguem rodava.

## 1. Criar o Deploy Hook no Render

1. Render → servico `kolecta-backend` → **Settings**
2. Secao **Deploy Hook** → copiar a URL (formato
   `https://api.render.com/deploy/srv-XXXX?key=YYYY`)

A URL e um segredo: quem tiver ela dispara deploy na sua producao.

## 2. Guardar como segredo no GitHub

1. GitHub → repo → **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret**
3. Nome: `RENDER_DEPLOY_HOOK_URL`
4. Valor: a URL do passo 1

## 3. DESLIGAR o auto-deploy no Render

Este passo e o que faz o gate valer. Sem ele o Render continua escutando o push
do GitHub e subindo direto, em paralelo com o workflow — ou seja, o codigo vai
para producao mesmo com os testes vermelhos, e o gate vira enfeite.

1. Render → servico `kolecta-backend` → **Settings** → **Build & Deploy**
2. **Auto-Deploy** → `No`

A partir dai, quem deploya e o workflow, e so depois de `build` + `test:all`
passarem na `main`.

## Como conferir que ficou certo

Abra um PR com um teste quebrado de proposito: o CI fica vermelho e **nenhum
deploy acontece**. Faca merge de algo trivial na `main`: o CI fica verde e o
Render registra um deploy novo poucos segundos depois.

## O que NAO esta no gate

`npm run lint` esta fora. Hoje o repo tem ~3900 erros de ESLint acumulados
(boa parte `no-unsafe-*` em codigo que lida com resposta de API externa), e o
proprio script usa `--fix`, que reescreve arquivo em vez de so reportar.

Gatear nisso hoje deixaria o CI vermelho para sempre, e CI que vive vermelho
ensina todo mundo a ignorar o sinal — que foi exatamente o que aconteceu com a
suite e2e, quebrada por meses ate 06/08/2026. Quando a divida for paga, e so
acrescentar um passo `npm run lint:check` no job `test`.
