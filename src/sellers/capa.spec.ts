import {
  COVER_OVERLAY_DEFAULT,
  COVER_OVERLAY_MAX,
  COVER_OVERLAY_MIN,
  montarCapa,
  urlDeCapaAceita,
} from './capa';

describe('Capa da loja', () => {
  describe('montarCapa', () => {
    it('sem imagem, não há capa', () => {
      expect(montarCapa({})).toBeNull();
      expect(montarCapa({ coverUrl: null, coverOverlay: 70 })).toBeNull();
    });

    it('preenche os defaults', () => {
      expect(montarCapa({ coverUrl: 'https://r2/capa.jpg' })).toEqual({
        url: 'https://r2/capa.jpg',
        focalY: 50,
        overlay: COVER_OVERLAY_DEFAULT,
      });
    });

    // O piso é a garantia de legibilidade, e ele tem que valer na SAÍDA, não só
    // na entrada: valor abaixo do mínimo pode já estar gravado (linha criada
    // antes desta regra, script, correção na mão no banco).
    it('reaplica o piso em valor gravado fora da faixa', () => {
      expect(montarCapa({ coverUrl: 'u', coverOverlay: 0 })?.overlay).toBe(
        COVER_OVERLAY_MIN,
      );
      expect(montarCapa({ coverUrl: 'u', coverOverlay: 200 })?.overlay).toBe(
        COVER_OVERLAY_MAX,
      );
    });

    it('mantém o valor escolhido dentro da faixa', () => {
      expect(montarCapa({ coverUrl: 'u', coverOverlay: 80 })?.overlay).toBe(80);
      expect(montarCapa({ coverUrl: 'u', coverFocalY: 0 })?.focalY).toBe(0);
      expect(montarCapa({ coverUrl: 'u', coverFocalY: 100 })?.focalY).toBe(100);
    });
  });

  describe('urlDeCapaAceita', () => {
    const original = process.env.CLOUDFLARE_R2_PUBLIC_URL;
    afterEach(() => {
      process.env.CLOUDFLARE_R2_PUBLIC_URL = original;
    });

    it('aceita o que veio do nosso R2', () => {
      process.env.CLOUDFLARE_R2_PUBLIC_URL = 'https://cdn.kolecta.com.br';
      expect(urlDeCapaAceita('https://cdn.kolecta.com.br/uploads/x/y.jpg')).toBe(
        true,
      );
    });

    it('recusa URL de fora', () => {
      process.env.CLOUDFLARE_R2_PUBLIC_URL = 'https://cdn.kolecta.com.br';
      expect(urlDeCapaAceita('https://servidor-do-vendedor.com/capa.jpg')).toBe(
        false,
      );
    });

    // Um domínio que só COMEÇA igual não é o nosso: "cdn.kolecta.com.br.mal.io"
    // passaria num startsWith ingênuo.
    it('recusa domínio que apenas começa igual', () => {
      process.env.CLOUDFLARE_R2_PUBLIC_URL = 'https://cdn.kolecta.com.br';
      expect(urlDeCapaAceita('https://cdn.kolecta.com.br.mal.io/capa.jpg')).toBe(
        false,
      );
    });

    it('ignora a barra final configurada no env', () => {
      process.env.CLOUDFLARE_R2_PUBLIC_URL = 'https://cdn.kolecta.com.br/';
      expect(urlDeCapaAceita('https://cdn.kolecta.com.br/uploads/a.jpg')).toBe(
        true,
      );
    });

    it('sem env configurado, não trava o cadastro', () => {
      delete process.env.CLOUDFLARE_R2_PUBLIC_URL;
      expect(urlDeCapaAceita('https://qualquer.com/capa.jpg')).toBe(true);
    });
  });
});
