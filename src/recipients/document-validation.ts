// Validação de dígito verificador de CPF e CNPJ (algoritmo oficial).
// A regex no DTO só garante o formato (tamanho); aqui validamos a integridade.

/** Valida CPF (11 dígitos) pelo dígito verificador. */
export function isValidCpf(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf)) return false;
  // Rejeita sequências repetidas (000... 111... etc.)
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digits = cpf.split('').map(Number);
  for (let j = 9; j < 11; j++) {
    let sum = 0;
    for (let i = 0; i < j; i++) {
      sum += digits[i] * (j + 1 - i);
    }
    let check = (sum * 10) % 11;
    if (check === 10) check = 0;
    if (check !== digits[j]) return false;
  }
  return true;
}

/** Valida CNPJ (14 dígitos) pelo dígito verificador. */
export function isValidCnpj(cnpj: string): boolean {
  if (!/^\d{14}$/.test(cnpj)) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const digits = cnpj.split('').map(Number);
  const calc = (len: number): number => {
    const weights =
      len === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += digits[i] * weights[i];
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  return calc(12) === digits[12] && calc(13) === digits[13];
}

/** Valida CPF ou CNPJ conforme o tamanho. */
export function isValidDocument(doc: string): boolean {
  return doc.length === 11 ? isValidCpf(doc) : isValidCnpj(doc);
}
