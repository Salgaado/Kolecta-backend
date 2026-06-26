import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Valida um CPF brasileiro pelos dígitos verificadores (não só formato).
 * Aceita string com ou sem máscara.
 */
export function isValidCpf(value: string): boolean {
  const cpf = String(value ?? '').replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  // Rejeita sequências repetidas (000.000.000-00, 111..., etc.)
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i], 10) * (10 - i);
  let check = (sum * 10) % 11;
  if (check === 10) check = 0;
  if (check !== parseInt(cpf[9], 10)) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i], 10) * (11 - i);
  check = (sum * 10) % 11;
  if (check === 10) check = 0;
  return check === parseInt(cpf[10], 10);
}

/**
 * Decorator class-validator: `@IsCpf()`.
 * A Pagar.me rejeita CPF com dígito verificador inválido com um genérico
 * "Erro no gateway" — validar aqui dá um erro claro antes da chamada externa.
 */
export function IsCpf(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCpf',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && isValidCpf(value);
        },
        defaultMessage() {
          return 'CPF inválido.';
        },
      },
    });
  };
}
