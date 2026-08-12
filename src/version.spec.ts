import { infoDoBuild, resumoDoBuild } from './version';

/**
 * O endpoint existe para responder "esse deploy subiu?" sem token. O risco de
 * um endpoint público de diagnóstico é virar vazamento a cada campo novo
 * adicionado "só para depurar" — por isso o formato é travado aqui.
 */
describe('infoDoBuild', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('usa o commit que a Render injeta no build', () => {
    process.env.RENDER_GIT_COMMIT = 'abc1234567890';
    process.env.RENDER_GIT_BRANCH = 'main';

    expect(infoDoBuild().commit).toBe('abc1234567890');
    expect(infoDoBuild().branch).toBe('main');
  });

  it('diz `desconhecido` em vez de inventar quando não há commit', () => {
    delete process.env.RENDER_GIT_COMMIT;
    delete process.env.GIT_COMMIT;
    delete process.env.SOURCE_VERSION;

    expect(infoDoBuild().commit).toBe('desconhecido');
  });

  /**
   * O que NÃO pode aparecer: o repositório é público e o SHA não é segredo,
   * mas qualquer outra variável de ambiente aqui seria vazamento.
   */
  it('expõe SOMENTE os campos previstos', () => {
    process.env.PAGARME_SECRET_KEY = 'sk_live_naovazar';
    process.env.TURSO_AUTH_TOKEN = 'token_naovazar';

    const info = infoDoBuild();

    expect(Object.keys(info).sort()).toEqual([
      'ambiente',
      'branch',
      'commit',
      'subiuEm',
      'uptimeSegundos',
    ]);
    expect(JSON.stringify(info)).not.toContain('naovazar');
  });

  it('o momento de subida é estável entre chamadas (identifica a instância)', () => {
    expect(infoDoBuild().subiuEm).toBe(infoDoBuild().subiuEm);
  });

  it('o resumo do log traz o commit curto', () => {
    process.env.RENDER_GIT_COMMIT = 'abc1234567890';
    expect(resumoDoBuild()).toContain('abc1234');
  });
});
