/**
 * Chaves de fachada para o e2e, carregadas antes de qualquer módulo.
 *
 * Vários serviços recusam ser instanciados sem credencial — o StripeService
 * estoura no construtor, por exemplo — e isso derrubava o `app.e2e-spec` antes
 * de ele chegar a qualquer asserção. O e2e ficou vermelho por meses e virou
 * ruído: ninguém rodava, então ele não protegia nada.
 *
 * Valor falso serve porque nada aqui faz chamada de rede só por ser
 * instanciado; a conexão acontece no primeiro uso, e o e2e não exercita rota
 * que use serviço externo.
 *
 * `??=` de propósito: quem já tem `.env` carregado (ou variável exportada na
 * mão) continua com o valor dele. O objetivo é destravar o boot, não sobrescrever
 * ambiente de ninguém.
 *
 * NUNCA colocar credencial real aqui: este arquivo é versionado.
 */
const FALSAS: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test_ficticia',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_ficticia',
  STRIPE_WEBHOOK_SECRET: 'whsec_ficticia',
  TURSO_DATABASE_URL: 'libsql://teste.turso.io',
  TURSO_AUTH_TOKEN: 'token-ficticio',
  CLERK_SECRET_KEY: 'sk_test_ficticia',
  CLERK_WEBHOOK_SECRET: 'whsec_ficticia',
  PAGARME_SECRET_KEY: 'sk_test_ficticia',
  MELHOR_ENVIO_TOKEN: 'token-ficticio',
};

for (const [chave, valor] of Object.entries(FALSAS)) {
  process.env[chave] ??= valor;
}
