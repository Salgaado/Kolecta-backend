/**
 * Endereço de volta do OAuth apontando para a máquina de alguém.
 *
 * É o erro mais fácil de cometer aqui e o mais difícil de perceber: o lojista
 * clica, é levado ao Bling, autoriza, e o navegador DELE tenta voltar para um
 * localhost que não existe. Do lado da Kolecta não chega nada: nenhum log,
 * nenhuma linha no banco. O sintoma é "ninguém conectou", indistinguível de
 * "ninguém tentou", e foi exatamente o que aconteceu.
 *
 * Espelha a checagem que `getAuthUrl` faz, sem precisar subir o Nest.
 */
const invalidoEmProducao = (uri: string) =>
  /localhost|127\.0\.0\.1|:\d{4,5}\/|^http:/i.test(uri);

describe('BLING_REDIRECT_URI em produção', () => {
  it('recusa localhost, que foi o caso real', () => {
    expect(invalidoEmProducao('http://localhost:3000/api/bling/callback')).toBe(true);
    expect(invalidoEmProducao('https://localhost/api/bling/callback')).toBe(true);
  });

  it('recusa IP de loopback e porta explícita', () => {
    expect(invalidoEmProducao('https://127.0.0.1/api/bling/callback')).toBe(true);
    expect(
      invalidoEmProducao('https://kolecta-backend.onrender.com:3000/api/bling/callback'),
    ).toBe(true);
  });

  it('recusa http sem TLS, que o Bling nem aceitaria', () => {
    expect(
      invalidoEmProducao('http://kolecta-backend.onrender.com/api/bling/callback'),
    ).toBe(true);
  });

  it('aceita a URL pública de produção', () => {
    expect(
      invalidoEmProducao('https://kolecta-backend.onrender.com/api/bling/callback'),
    ).toBe(false);
  });

  it('aceita domínio próprio, para quando a API sair do Render', () => {
    expect(invalidoEmProducao('https://api.kolecta.com.br/api/bling/callback')).toBe(false);
  });
});
