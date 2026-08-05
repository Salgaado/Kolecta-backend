import {
  normalizarMarca,
  normalizarEscala,
  normalizarLinha,
} from './normalizacao';

/**
 * A importação por planilha era o único caminho de escrita que não normalizava.
 * O estrago medido no banco em 05/08/2026 é modesto ("COPAG"/"Copag"/"Copag ",
 * "MATTEL"/"Mattel") e não racha nenhuma prateleira, porque a vitrine agrupa
 * por chave normalizada.
 *
 * A trava importa pelo que vem: a importação do Bling trará marca digitada por
 * cada lojista no ERP dele, sem curadoria de grafia.
 */
describe('normalizarMarca', () => {
  it('tira o espaço sobrando, que foi o que o banco pegou', () => {
    expect(normalizarMarca('Copag ')).toBe('Copag');
    expect(normalizarMarca('  Mattel  ')).toBe('Mattel');
  });

  it('NÃO força a caixa de marca fora da lista', () => {
    // "COPAG" e "MSZ" se escrevem em caixa alta de verdade. Forçar title case
    // consertaria "COPAG" contra "Copag" e estragaria "MSZ", "CCA" e "IXO".
    // Fica como o vendedor escreveu, igual ao front.
    expect(normalizarMarca('COPAG')).toBe('COPAG');
    expect(normalizarMarca('MSZ')).toBe('MSZ');
  });

  it('canoniza para a grafia da lista, não para a primeira que chegou', () => {
    expect(normalizarMarca('hot wheels')).toBe('Hot Wheels');
    expect(normalizarMarca('HOT-WHEELS')).toBe('Hot Wheels');
    // Os 5 acessórios ativos tinham as três formas abaixo. "Storehouse Custom"
    // está na lista canônica, então as duas primeiras deviam ter convergido.
    expect(normalizarMarca('Storehousecustom')).toBe('Storehouse Custom');
    expect(normalizarMarca('StorehouseCustom')).toBe('Storehouse Custom');
  });

  it('ignora acento na comparação', () => {
    expect(normalizarMarca('carros inesqueciveis')).toBe('Carros Inesquecíveis');
  });

  it('preserva marca fora da lista, só aparada', () => {
    // Apagar seria pior que a grafia torta: marca pequena de verdade é
    // informação, e o vendedor não tem outro campo para colocá-la.
    expect(normalizarMarca('  Oficina do Zé  ')).toBe('Oficina do Zé');
    expect(normalizarMarca('Marca   com   espaco')).toBe('Marca com espaco');
  });

  it('vazio vira null, não string vazia', () => {
    expect(normalizarMarca('   ')).toBeNull();
    expect(normalizarMarca(null)).toBeNull();
    expect(normalizarMarca(undefined)).toBeNull();
  });
});

describe('normalizarEscala', () => {
  it('aceita as grafias que aparecem no banco', () => {
    expect(normalizarEscala('1/64')).toBe('1:64');
    expect(normalizarEscala('1-64')).toBe('1:64');
    expect(normalizarEscala('1 : 64')).toBe('1:64');
  });

  it('"outra" em qualquer caixa vira Outra', () => {
    expect(normalizarEscala('OUTRA')).toBe('Outra');
  });

  it('escala desconhecida é preservada, não descartada', () => {
    expect(normalizarEscala('1:87')).toBe('1:87');
  });
});

describe('normalizarLinha', () => {
  it('apara e colapsa espaço', () => {
    expect(normalizarLinha('  Mainline  ')).toBe('Mainline');
    expect(normalizarLinha('Car   Culture')).toBe('Car Culture');
  });

  it('vazio vira null', () => {
    expect(normalizarLinha('')).toBeNull();
  });
});
