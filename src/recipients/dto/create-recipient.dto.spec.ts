// Os decorators do class-validator dependem disto. Em produção quem carrega é o
// bootstrap do Nest; num spec avulso, ninguém — sem esta linha o arquivo nem
// compila ("Reflect.getMetadata is not a function").
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BankAccountDto } from './create-recipient.dto';

/**
 * Conta bancária do recebedor.
 *
 * Os casos abaixo não são inventados: cada um foi disparado contra a API da
 * Pagar.me em 06/08/2026, um campo por vez, e o que está aqui é o que ela
 * respondeu. Antes disso o DTO só exigia `@IsString()`, e o valor torto ia até
 * a Pagar.me — o vendedor recebia um erro em inglês citando
 * `branch_check_digit`, campo que não existe na tela dele.
 *
 * O que a Pagar.me respondeu, para cada campo:
 *
 *   branch_number        4 ok   | 5  → 412 "agencia | Value too long"
 *   branch_check_digit   1 ok   | 2  → 412 "agencia_dv | Invalid format"
 *                               | 9+ → 422 "must be a string with a
 *                                            maximum length of 8"
 *   account_number      13 ok   | 14 → 412 "conta | Value too long"
 *   account_check_digit  2 ok   | 3  → 412 "conta_dv | Value too long"
 *
 * "X" é aceito nos dois dígitos (Banco do Brasil usa letra) — confirmado com
 * recebedor criado e `status: active`. Regex só de `\d` barraria esses.
 */
describe('BankAccountDto', () => {
  const valida = {
    holderName: 'Fulano de Tal',
    holderType: 'individual',
    holderDocument: '26224451990',
    bank: '341',
    branchNumber: '1234',
    branchCheckDigit: '5',
    accountNumber: '12345',
    accountCheckDigit: '6',
    accountType: 'checking',
  };

  async function erros(sobrescreve: Record<string, unknown>) {
    const dto = plainToInstance(BankAccountDto, { ...valida, ...sobrescreve });
    const resultado = await validate(dto);
    return resultado.map((e) => e.property);
  }

  it('aceita uma conta bem preenchida', async () => {
    expect(await erros({})).toEqual([]);
  });

  // ── Dígito da agência: o campo que quebrou ────────────────────────────────

  it('recusa o dígito da agência com 9 caracteres', async () => {
    // O caso real: a Pagar.me devolvia 422 falando de um campo que o vendedor
    // nunca viu. Agora para aqui, em português.
    expect(await erros({ branchCheckDigit: '123456789' })).toEqual([
      'branchCheckDigit',
    ]);
  });

  it('recusa o dígito da agência com 2 caracteres', async () => {
    // Entre 2 e 8 a Pagar.me nem dava o 422: dava 412 "Invalid format", que é
    // ainda menos explicável para quem está cadastrando conta.
    expect(await erros({ branchCheckDigit: '12' })).toEqual([
      'branchCheckDigit',
    ]);
  });

  it('recusa a agência inteira colada no campo do dígito', async () => {
    expect(await erros({ branchCheckDigit: '1234-5' })).toEqual([
      'branchCheckDigit',
    ]);
  });

  it('aceita letra no dígito da agência (Banco do Brasil usa X)', async () => {
    expect(await erros({ branchCheckDigit: 'X' })).toEqual([]);
  });

  it('aceita dígito de agência ausente: nem toda agência tem', async () => {
    expect(await erros({ branchCheckDigit: undefined })).toEqual([]);
  });

  // ── Os vizinhos, que tinham o mesmo buraco ────────────────────────────────

  it('recusa agência com 5 dígitos', async () => {
    expect(await erros({ branchNumber: '12345' })).toEqual(['branchNumber']);
  });

  it('recusa conta com 14 dígitos', async () => {
    expect(await erros({ accountNumber: '12345678901234' })).toEqual([
      'accountNumber',
    ]);
  });

  it('aceita conta com 13 dígitos, que é o limite real', async () => {
    expect(await erros({ accountNumber: '1234567890123' })).toEqual([]);
  });

  it('recusa dígito de conta com 3 caracteres', async () => {
    expect(await erros({ accountCheckDigit: '123' })).toEqual([
      'accountCheckDigit',
    ]);
  });

  it('aceita dígito de conta com 2 caracteres', async () => {
    expect(await erros({ accountCheckDigit: '12' })).toEqual([]);
  });

  it('recusa letra na agência e na conta, que são só números', async () => {
    expect(await erros({ branchNumber: '12A4' })).toEqual(['branchNumber']);
    expect(await erros({ accountNumber: '123X5' })).toEqual(['accountNumber']);
  });
});
