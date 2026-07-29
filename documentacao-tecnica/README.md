# Documentação técnica da Kolecta

Fotografia original de **25 de julho de 2026**, atualizada em **27 de julho de
2026** (vitrine filtrada no servidor, foto do vendedor na API, baixa de estoque
na venda e faixa da concessão de fundador — ver
[Estado, riscos e divergências](./07-estado-riscos.md)).

Descreve o estado do código dos projetos:

- `kolecta-backend`: API, regras de domínio, persistência, integrações e rotinas.
- `kolecta-the-collector-s-hub`: aplicação web, rotas, estado, consumo da API e experiência dos usuários.

## Como esta documentação foi produzida

O conteúdo foi reconstruído diretamente do código-fonte, configurações executáveis, testes e saídas JSON/HTML do Graphify. Como solicitado, não foram usados como fonte:

- arquivos `.md`, `.txt` ou `.pdf`;
- as pastas `docs`, `.agent`/`.agents` e `.claude`;
- documentação histórica já existente.

Isso torna este conjunto uma fotografia independente do comportamento implementado. Comentários dentro do próprio código foram considerados parte do código analisado, mas afirmações relevantes foram conferidas contra DTOs, controllers, services, schema ou chamadas reais.

Os grafos analisados registram:

- backend: 1.252 nós, 2.134 ligações, commit analisado `b4956edf207784618c8bcfbf2c55457246a9e5f3`;
- frontend: 1.273 nós, 3.452 ligações, commit analisado `27a68a80dfc50c2625582b48053dd96e8c71cd02`.

Como os grafos podem estar atrás do working tree, eles foram usados para localizar acoplamentos e não como única fonte de verdade.

A atualização de 27/07 seguiu o mesmo critério e acrescentou uma fonte: leitura
somente-leitura do **banco de produção** (contagem de anúncios por status,
fundadores concedidos, índices existentes) e medição do endpoint público em
produção. Onde este texto cita número de produção, ele foi lido, não estimado.

## Índice

1. [Visão integrada](./01-visao-integrada.md)
2. [Backend: arquitetura e domínio](./02-backend.md)
3. [Backend: referência da API](./03-api-backend.md)
4. [Modelo de dados](./04-modelo-de-dados.md)
5. [Frontend: arquitetura, rotas e funcionalidades](./05-frontend.md)
6. [Operação, configuração e manutenção](./06-operacao.md)
7. [Estado verificado, riscos e divergências](./07-estado-riscos.md)

## Estado verificado

| Projeto | Verificação | Resultado |
|---|---|---|
| Backend | `npm test` | 29 suítes e 325 testes passando |
| Backend | `npm run build` | concluído |
| Frontend | `npm test` | 38 arquivos e 390 testes passando |
| Frontend | `npm run build` | concluído, com avisos não bloqueantes |

Os testes E2E do Nest e do Playwright existem, mas não foram executados nesta fotografia porque dependem de ambiente e/ou serviços externos. Consulte [Operação](./06-operacao.md).

## Leitura rápida para retomar o trabalho

Para entender o sistema em poucos minutos:

1. leia a [Visão integrada](./01-visao-integrada.md);
2. consulte [Estado, riscos e divergências](./07-estado-riscos.md);
3. abra o documento específico do projeto em que vai trabalhar;
4. use a [referência da API](./03-api-backend.md) e o [modelo de dados](./04-modelo-de-dados.md) durante a implementação.

