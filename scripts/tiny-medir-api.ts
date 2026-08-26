/**
 * Mede a API v3 do Tiny (Olist ERP) contra uma conta REAL, e responde as
 * perguntas que o Swagger deles não responde. Fase 0 do docs/PLAN-tiny-olist.md.
 *
 * Por que existe: o plano inteiro tem quatro "⚠️" que só uma resposta de
 * verdade resolve, e cada um deles muda uma decisão de código —
 *
 *   1. A listagem de produtos traz SALDO? Se trouxer, a sincronização de
 *      estoque de um lojista cabe em 1–3 chamadas por rodada; se não trouxer, é
 *      uma chamada POR PRODUTO, e com 30 leituras/min o desenho tem que mudar.
 *   2. Em que UNIDADE vêm peso e dimensões? No Bling eu li centímetro como
 *      metro e o frete seria cotado sobre uma caixa cem vezes maior.
 *   3. A URL da foto (`anexos[].url`) é assinada e expira? Se for, gravá-la no
 *      anúncio deixa o vendedor sem foto uma semana depois.
 *   4. Quanto tempo vale o access_token?
 *
 * SÓ LÊ. Nenhuma escrita, nenhum cadastro, nenhum produto criado.
 *
 * Gasta no máximo 4 requisições — de propósito: o limite por minuto é da CONTA
 * do lojista, e é o mesmo limite que o ERP dele usa para falar com Mercado
 * Livre e Shopee.
 *
 *   npx ts-node --transpile-only scripts/tiny-medir-api.ts <access_token>
 *   TINY_ACCESS_TOKEN=... npx ts-node --transpile-only scripts/tiny-medir-api.ts
 *
 * Como obter o token antes de a integração existir: no painel do Tiny, criar o
 * aplicativo v3, abrir a URL de autorização na mão e trocar o `code` no
 * endpoint de token do Keycloak (ver TINY_TOKEN_URL em src/tiny/tiny.service.ts).
 */
import 'dotenv/config';

// api.tiny.com.br é o host dos DADOS. erp.tiny.com.br é só a documentação e
// devolve "recurso não encontrado" para tudo. Ver o comentário dos três hosts
// em src/tiny/tiny.service.ts.
const API = 'https://api.tiny.com.br/public-api/v3';

const token = process.argv[2] ?? process.env.TINY_ACCESS_TOKEN;
if (!token) {
  console.error(
    'Falta o access_token.\n' +
      '  npx ts-node --transpile-only scripts/tiny-medir-api.ts <access_token>',
  );
  process.exit(1);
}

async function get(caminho: string): Promise<any> {
  const res = await fetch(`${API}${caminho}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  // Cabeçalhos de limite, se existirem: é o jeito de saber quanto do orçamento
  // do lojista a nossa sincronização come, sem perguntar para o suporte.
  const limites = [...res.headers.entries()].filter(([k]) =>
    /ratelimit|retry-after|x-rate/i.test(k),
  );
  if (limites.length) {
    console.log('   cabeçalhos de limite:', Object.fromEntries(limites));
  }

  if (!res.ok) {
    const corpo = await res.text();
    throw new Error(
      `GET ${caminho} -> HTTP ${res.status}: ${corpo.slice(0, 400)}`,
    );
  }
  return res.json();
}

/** Mostra o JSON inteiro, que é o ponto: o Swagger é que está incompleto. */
function dump(rotulo: string, valor: unknown) {
  console.log(`\n${rotulo}:`);
  console.log(JSON.stringify(valor, null, 2).slice(0, 4000));
}

(async () => {
  // ── 1. Prova de vida ───────────────────────────────────────────────────────
  console.log('1) GET /info — a conta responde e o token vale?');
  const info = await get('/info');
  dump('conta', info);

  // ── 2. A listagem traz saldo? ──────────────────────────────────────────────
  console.log('\n2) GET /produtos?limit=3 — a listagem traz SALDO?');
  const lista = await get('/produtos?limit=3&situacao=A');
  const itens: any[] = lista?.itens ?? [];
  dump('paginacao', lista?.paginacao);
  dump('primeiro item da listagem', itens[0]);

  const temSaldoNaListagem =
    itens[0]?.estoque != null &&
    Object.keys(itens[0].estoque).some((k) =>
      /saldo|quantidade|disponivel/i.test(k),
    );

  console.log(
    `\n   >>> RESPOSTA 1: a listagem ${temSaldoNaListagem ? 'TRAZ' : 'NÃO traz'} saldo.`,
  );
  console.log(
    temSaldoNaListagem
      ? '       Sincronização de estoque cabe na listagem paginada: 1–3 chamadas por lojista.'
      : '       Sincronização precisa de 1 chamada POR PRODUTO. Usar dataAlteracao para\n' +
          '       consultar só o que mudou, senão estoura o limite da conta do lojista.',
  );

  if (!itens.length) {
    console.log(
      '\nCatálogo vazio — cadastre um produto de teste e rode de novo.',
    );
    return;
  }

  // ── 3. Detalhe: unidade das medidas e formato da foto ──────────────────────
  const id = itens[0].id;
  console.log(
    `\n3) GET /produtos/${id} — unidades, fotos e estoque no detalhe`,
  );
  const detalhe = await get(`/produtos/${id}`);
  dump('dimensoes', detalhe?.dimensoes);
  dump('estoque (no detalhe)', detalhe?.estoque);
  dump('anexos', detalhe?.anexos);

  console.log(
    '\n   >>> RESPOSTA 2: compare os números de `dimensoes` com as medidas que\n' +
      '       você cadastrou no produto de teste. 20x15x10 cm voltando como\n' +
      '       20/15/10 é centímetro; como 0.2/0.15/0.1 é metro.',
  );

  const urlFoto: string | undefined = detalhe?.anexos?.[0]?.url;
  if (urlFoto) {
    const assinada = /[?&](x-amz-|signature|expires|token|se=)/i.test(urlFoto);
    console.log(
      `\n   >>> RESPOSTA 3: a URL da foto ${assinada ? 'PARECE ASSINADA' : 'parece pública'}.`,
    );
    console.log(
      assinada
        ? '       Nunca gravar no anúncio: baixar e copiar para o R2 na importação.'
        : '       Ainda assim copiar para o R2: link de terceiro some sem aviso.',
    );
    console.log(`       ${urlFoto.slice(0, 200)}`);
  } else {
    console.log(
      '\n   >>> RESPOSTA 3: produto de teste sem foto — suba uma e rode de novo.',
    );
  }

  // ── 4. Saldo dedicado ──────────────────────────────────────────────────────
  console.log(`\n4) GET /estoque/${id} — o formato do saldo`);
  const estoque = await get(`/estoque/${id}`);
  dump('estoque', estoque);
  console.log(
    '\n   Lembrete: o número que a Kolecta usa é o `disponivel` (saldo menos\n' +
      '   reservado). O físico só cai quando a peça sai da caixa, e até lá o\n' +
      '   anúncio continuaria vendendo algo que já tem dono.',
  );

  console.log(
    '\n— Fim. Cole este resultado em docs/PLAN-tiny-olist.md, na seção dos ⚠️. —',
  );
})().catch((e) => {
  console.error(`\n${e.message ?? e}`);
  process.exit(1);
});
