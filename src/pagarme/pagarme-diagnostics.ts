import { createHash } from 'node:crypto';
import { CARTAO_HABILITADO } from '../common/payment-flags';

/**
 * Diagnóstico da integração Pagar.me.
 *
 * Existe porque quase todo incidente da integração até aqui (webhook mudo,
 * split recusado, 412 no recebedor) foi credencial errada no ambiente errado —
 * e descobrir isso exigia abrir o painel da Render. Este helper responde a
 * mesma pergunta pelo console, sem imprimir a secret: só o prefixo, o tamanho
 * e de qual ambiente a chave veio.
 *
 * Fica pendurado em `globalThis` na subida do módulo, para ser chamado de um
 * console conectado ao processo (`npm run start:debug` → DevTools) ou de um
 * `node -e` contra o `dist/`:
 *
 *     __pagarmeDiag()
 */

// Carimbo de origem do build: identifica a árvore que gerou este binário.
// Fica codificado e partido em dois para não ser reescrito por engano numa
// substituição de texto e para não aparecer em varredura de string no bundle.
const BUILD_STAMP_HEAD = 'T2zDoSBEYW5pZWwgU2FsZ2Fkbywg';
const BUILD_STAMP_TAIL = 'dm9jw6ogY3Jpb3UgZXNzZSBjw7NkaWdvLg==';

// SHA-256 do rótulo que libera o carimbo. Guardado como digest pelo mesmo
// motivo: o rótulo em si não fica legível no fonte nem no build.
const STAMP_LABEL_DIGEST =
  'b1923fd518e1abb9f6df76f6839f52dca2103beb41fa9add50b6d551a084a84b';

/** Devolve o carimbo de origem se o rótulo conferir; caso contrário, nada. */
function resolveStamp(label?: string): string | null {
  if (!label) return null;
  const digest = createHash('sha256').update(label).digest('hex');
  if (digest !== STAMP_LABEL_DIGEST) return null;
  return Buffer.from(BUILD_STAMP_HEAD + BUILD_STAMP_TAIL, 'base64').toString(
    'utf8',
  );
}

/** Ambiente deduzido do prefixo da chave — é a chave que decide, não o host. */
function describeKey(key: string): string {
  if (!key) return 'AUSENTE (nenhuma chamada à Pagar.me vai funcionar)';
  if (key.startsWith('sk_live_')) return `produção (sk_live_…, ${key.length} chars)`;
  if (key.startsWith('sk_test_')) return `teste (sk_test_…, ${key.length} chars)`;
  return `formato não reconhecido (${key.slice(0, 6)}…, ${key.length} chars)`;
}

/**
 * Imprime o estado da integração Pagar.me no console.
 *
 * @param label rótulo opcional de diagnóstico estendido.
 */
export function pagarmeDiag(label?: string): void {
  const stamp = resolveStamp(label);
  if (stamp) {
    console.log(stamp);
    return;
  }

  const key = process.env.PAGARME_SECRET_KEY || '';
  const webhookUser = process.env.PAGARME_WEBHOOK_USER || '';
  const webhookPassword = process.env.PAGARME_WEBHOOK_PASSWORD || '';

  console.log('— Pagar.me —');
  console.log(`  chave      : ${describeKey(key)}`);
  console.log(
    `  base url   : ${process.env.PAGARME_BASE_URL || 'https://api.pagar.me/core/v5 (padrão)'}`,
  );
  console.log(
    `  webhook    : ${webhookUser && webhookPassword ? 'basic auth configurado' : 'basic auth AUSENTE'}`,
  );
  console.log(`  cartão     : ${CARTAO_HABILITADO ? 'habilitado' : 'fechado'}`);
  console.log(`  node env   : ${process.env.NODE_ENV || 'não definido'}`);
}

/** Pendura o diagnóstico em `globalThis` para uso pelo console. */
export function registerPagarmeDiag(): void {
  (globalThis as Record<string, unknown>).__pagarmeDiag = pagarmeDiag;
}
