/**
 * Identidade do build que está rodando.
 *
 * Existe por uma limitação concreta que atrapalhou em 12/08: não havia como
 * saber QUAL código estava em produção. A única forma de checar se um deploy
 * tinha subido era sondar rotas e comparar 401 contra 404 — o que só funciona
 * quando a mudança adiciona uma rota nova. Numa correção dentro de uma rota que
 * já existia, não funcionava de jeito nenhum, e restava esperar e torcer.
 *
 * O SHA não é segredo: o repositório do backend é público. O que NÃO entra aqui
 * é qualquer outra variável de ambiente — a tentação de "só mais um campo para
 * depurar" é como um endpoint de diagnóstico vira vazamento.
 */

/** Momento em que o processo subiu — é isso que muda quando um deploy troca. */
const SUBIU_EM = new Date().toISOString();

export interface InfoDoBuild {
  /** SHA do commit. `desconhecido` fora da Render (ex.: rodando local). */
  commit: string;
  branch: string;
  ambiente: string;
  /** ISO-8601 de quando ESTA instância iniciou. */
  subiuEm: string;
  uptimeSegundos: number;
}

export function infoDoBuild(): InfoDoBuild {
  return {
    // A Render injeta `RENDER_GIT_COMMIT` no build. Os outros nomes cobrem
    // quem rodar isto em outro lugar sem precisar mexer no código.
    commit:
      process.env.RENDER_GIT_COMMIT ??
      process.env.GIT_COMMIT ??
      process.env.SOURCE_VERSION ??
      'desconhecido',
    branch: process.env.RENDER_GIT_BRANCH ?? process.env.GIT_BRANCH ?? 'main',
    ambiente: process.env.NODE_ENV ?? 'development',
    subiuEm: SUBIU_EM,
    uptimeSegundos: Math.round(process.uptime()),
  };
}

/** Versão curta para log de inicialização. */
export function resumoDoBuild(): string {
  const i = infoDoBuild();
  return `commit ${i.commit.slice(0, 7)} (${i.branch}) · ${i.ambiente}`;
}
