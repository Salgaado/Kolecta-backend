/**
 * Leitura do motivo de uma falha da Pagar.me.
 *
 * Existem DUAS camadas de falha, e só a primeira passa por aqui:
 *
 * 1. **Request recusado (HTTP 4xx)** — a Pagar.me olhou o payload, achou campo
 *    faltando ou inválido e não criou cobrança nenhuma. Vira exceção, cai no
 *    `catch` de quem chamou, e é o que esta função lê.
 *
 * 2. **Cobrança recusada (HTTP 200)** — o request foi aceito, mas o antifraude
 *    ou a adquirente disseram não. É uma resposta de SUCESSO com a recusa
 *    dentro (`charges[].last_transaction.gateway_response.errors`, aí sim uma
 *    lista). Não passa por aqui: quem trata é o `if (!authorized)` de cada
 *    fluxo, lendo a resposta.
 *
 * A pegadinha é que a camada 1 devolve `errors` como OBJETO indexado pelo campo
 * — `{ billing: ['"value" is required'] }` — enquanto a camada 2 devolve uma
 * LISTA. Os chamadores foram escritos esperando a lista, então o motivo real da
 * camada 1 escapava e a mensagem caía no `message` do nosso próprio embrulho
 * ("Erro na comunicação com a Pagar.me"), que sugere problema de rede quando na
 * verdade faltou um campo. Foi o que escondeu por dois dias a ausência do
 * `billing_address` no pagamento de arremate (12/08).
 *
 * Aceita as duas formas de propósito: o encadeamento antigo não estava errado,
 * estava incompleto.
 */
interface CorpoErroPagarme {
  message?: string;
  errors?: { message?: string }[] | Record<string, string | string[]>;
}

/**
 * Motivo legível de uma falha da Pagar.me, ou `null` quando não dá para saber.
 *
 * Na validação devolve `campo: motivo` (ex.: `billing: "value" is required`) —
 * o nome do campo é a única informação acionável nesse erro, e é justamente o
 * que se perdia.
 */
export function motivoPagarme(err: unknown): string | null {
  // O `PagarmeService` embrulha tudo em HttpException({ message, pagarme }),
  // então o corpo da Pagar.me fica em `response.pagarme`. O fallback para o
  // `response` cru cobre quem chama a API por fora desse wrapper.
  const resposta = (err as { response?: unknown })?.response;
  const corpo = ((resposta as { pagarme?: unknown })?.pagarme ?? resposta) as
    | CorpoErroPagarme
    | undefined;
  const errors = corpo?.errors;

  if (Array.isArray(errors)) {
    const msgs = errors.map((e) => e?.message).filter(Boolean);
    if (msgs.length) return msgs.join('; ');
  } else if (errors && typeof errors === 'object') {
    const partes = Object.entries(errors).map(
      ([campo, msgs]) =>
        `${campo}: ${[msgs].flat().filter(Boolean).join(', ')}`,
    );
    if (partes.length) return partes.join('; ');
  }

  return corpo?.message || (err as { message?: string })?.message || null;
}
