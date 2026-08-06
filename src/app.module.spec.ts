import { Test } from '@nestjs/testing';

/**
 * O grafo de injeção do app inteiro resolve?
 *
 * Esta é a pergunta que nenhum teste fazia, e ela derrubou a produção em
 * 06/08/2026: o AnalyticsModule usava `@UseGuards(RolesGuard)` sem importar o
 * AuthModule, o Nest não achou o UsersService para injetar no guard e abortou o
 * bootstrap. Erro de injeção acontece na SUBIDA, então não quebra só a rota
 * culpada — a API inteira para, e o processo entra em crash loop.
 *
 * Os unitários não pegam porque instanciam classe por classe, passando os
 * colaboradores na mão; o `AppModule` nunca é montado. O e2e em `test/` monta,
 * mas depende de rede e de chaves reais, então vive quebrado e ninguém roda.
 *
 * Aqui é só `compile()`, sem `app.init()`: instancia todos os providers (que é
 * onde o erro aparece) e não abre servidor, cron nem conexão de banco. Roda em
 * `npm test` junto do resto, em ~1s.
 *
 * Quando este teste quebrar, leia a mensagem do Nest: ela diz o módulo e o
 * provider que faltam, e a correção quase sempre é importar o AuthModule (que
 * exporta AuthGuard, RolesGuard e o UsersModule de que o guard depende).
 */
describe('AppModule — grafo de injeção', () => {
  // Chaves de fachada: alguns serviços recusam subir sem elas (StripeService
  // estoura no construtor, por exemplo). Nenhuma chamada de rede acontece só
  // por instanciar, então valor falso serve — e é melhor que ler o .env, que
  // não existe no CI e traria credencial de verdade para dentro do teste.
  const FALSAS: Record<string, string> = {
    STRIPE_SECRET_KEY: 'sk_test_ficticia',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_ficticia',
    STRIPE_WEBHOOK_SECRET: 'whsec_ficticia',
    TURSO_DATABASE_URL: 'libsql://teste.turso.io',
    TURSO_AUTH_TOKEN: 'token-ficticio',
    CLERK_SECRET_KEY: 'sk_test_ficticia',
    PAGARME_SECRET_KEY: 'sk_test_ficticia',
  };

  const anterior: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [chave, valor] of Object.entries(FALSAS)) {
      anterior[chave] = process.env[chave];
      process.env[chave] ??= valor;
    }
  });

  afterAll(() => {
    for (const [chave, valor] of Object.entries(anterior)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  });

  it('resolve todo provider de todo módulo', async () => {
    // `require` e não `import`: a carga tem que acontecer DEPOIS do beforeAll
    // (o AppModule lê env na carga), e o `import` do ES é içado para o topo do
    // arquivo, o que faria o módulo carregar antes das chaves existirem.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppModule } = require('./app.module');

    await expect(
      Test.createTestingModule({ imports: [AppModule] }).compile(),
    ).resolves.toBeDefined();
  }, 60000);
});
