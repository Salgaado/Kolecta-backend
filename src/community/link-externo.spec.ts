import { linksExternosEm, motivoDeRecusa } from './link-externo';

/**
 * A regra nasceu de três comentários no ar apontando para uma loja
 * concorrente. O risco de errar a mão é recusar comentário legítimo, então os
 * testes de falso positivo importam tanto quanto os de bloqueio.
 */
describe('linksExternosEm', () => {
  it('pega o caso real que motivou a regra', () => {
    expect(linksExternosEm('https://raapcollection.com.br/pt/miniature/MGT-1344'))
      .toEqual(['raapcollection.com.br']);
  });

  it('pega link escrito SEM http, que é como se divulga de verdade', () => {
    // Uma regex que só olhasse https:// deixaria passar exatamente isto.
    expect(linksExternosEm('compra na lojinha.com.br/produto que é mais barato'))
      .toEqual(['lojinha.com.br']);
  });

  it('deixa passar link da própria Kolecta, que é o que a gente quer', () => {
    expect(linksExternosEm('olha esse: https://kolecta.com.br/produto/abc')).toEqual([]);
    expect(linksExternosEm('https://www.kolecta.com.br/comunidade')).toEqual([]);
  });

  it('não confunde escala nem preço com domínio', () => {
    // "1:64" e "R$ 149.90" apareceriam como domínio numa regex ingênua, e o
    // comentário seria recusado por falar de miniatura.
    expect(linksExternosEm('Miniatura 1:64, paguei R$ 149.90 nela')).toEqual([]);
    expect(linksExternosEm('escala 1/43 versus 1.18')).toEqual([]);
  });

  it('texto sem link nenhum passa', () => {
    expect(linksExternosEm('Que peça linda, parabéns pela coleção!')).toEqual([]);
    expect(linksExternosEm('')).toEqual([]);
    expect(linksExternosEm(null)).toEqual([]);
  });

  it('não repete o mesmo domínio citado várias vezes', () => {
    expect(linksExternosEm('loja.com/a e loja.com/b e loja.com/c')).toEqual(['loja.com']);
  });
});

describe('motivoDeRecusa', () => {
  it('diz QUAL domínio travou e o que fazer no lugar', () => {
    // "Conteúdo não permitido" deixaria quem colou sem querer sem saber o que
    // corrigir. Quem colou de propósito já sabe.
    const m = motivoDeRecusa('vem ver em raapcollection.com.br');
    expect(m).toContain('raapcollection.com.br');
    expect(m).toMatch(/anúncio aqui da plataforma/);
  });

  it('devolve null quando pode publicar', () => {
    expect(motivoDeRecusa('Muito bom!')).toBeNull();
    expect(motivoDeRecusa('https://kolecta.com.br/produto/1')).toBeNull();
  });
});
