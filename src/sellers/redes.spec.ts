import {
  handlesBrutos,
  montarRedes,
  normalizarRede,
  urlDaRede,
  urlDeWebsite,
} from './redes';

describe('Redes sociais da loja', () => {
  describe('normalizarRede — as três formas que o vendedor tem à mão', () => {
    it('aceita o @handle, que é o que ele copia do app', () => {
      expect(normalizarRede('instagram', '@lojanerd')).toBe('lojanerd');
      expect(normalizarRede('tiktok', '@lojanerd')).toBe('lojanerd');
    });

    it('aceita o handle sem @', () => {
      expect(normalizarRede('instagram', 'lojanerd')).toBe('lojanerd');
      expect(normalizarRede('tiktok', 'lojanerd')).toBe('lojanerd');
    });

    it('aceita a URL inteira e chega no mesmo lugar', () => {
      expect(normalizarRede('instagram', 'https://www.instagram.com/lojanerd')).toBe(
        'lojanerd',
      );
      expect(normalizarRede('tiktok', 'https://www.tiktok.com/@lojanerd')).toBe(
        'lojanerd',
      );
    });

    it('aceita URL sem protocolo, que é como o vendedor digita', () => {
      expect(normalizarRede('instagram', 'instagram.com/lojanerd')).toBe('lojanerd');
      expect(normalizarRede('tiktok', 'www.tiktok.com/@lojanerd')).toBe('lojanerd');
    });

    // As três formas têm que convergir, senão o mesmo vendedor gravaria coisas
    // diferentes dependendo de onde copiou o link.
    it('as três formas gravam exatamente o mesmo valor', () => {
      const porHandle = normalizarRede('instagram', '@lojanerd');
      const porNome = normalizarRede('instagram', 'lojanerd');
      const porUrl = normalizarRede('instagram', 'https://instagram.com/lojanerd');
      expect(porHandle).toBe(porNome);
      expect(porNome).toBe(porUrl);
    });

    // Handle com ponto é válido no Instagram. Se a detecção de URL testasse
    // ponto em vez de barra, "loja.nerd" viraria um domínio e seria recusado.
    it('handle com ponto continua sendo handle, não domínio', () => {
      expect(normalizarRede('instagram', 'loja.nerd')).toBe('loja.nerd');
      expect(normalizarRede('instagram', '@loja.nerd')).toBe('loja.nerd');
    });

    it('ignora espaço em volta e valor vazio', () => {
      expect(normalizarRede('instagram', '  @lojanerd  ')).toBe('lojanerd');
      expect(normalizarRede('instagram', '   ')).toBeNull();
      expect(normalizarRede('instagram', '')).toBeNull();
      expect(normalizarRede('instagram', null)).toBeNull();
      expect(normalizarRede('instagram', undefined)).toBeNull();
    });
  });

  describe('normalizarRede — YouTube tem três endereços e eles não se misturam', () => {
    it('guarda o handle moderno com o @', () => {
      expect(normalizarRede('youtube', 'https://youtube.com/@canaldaloja')).toBe(
        '@canaldaloja',
      );
      expect(normalizarRede('youtube', '@canaldaloja')).toBe('@canaldaloja');
      expect(normalizarRede('youtube', 'canaldaloja')).toBe('@canaldaloja');
    });

    it('preserva /c/ e /channel/, que são outros endereços', () => {
      expect(normalizarRede('youtube', 'https://youtube.com/c/canaldaloja')).toBe(
        'c/canaldaloja',
      );
      expect(
        normalizarRede('youtube', 'https://www.youtube.com/channel/UCabcdefghij123'),
      ).toBe('channel/UCabcdefghij123');
      expect(normalizarRede('youtube', 'https://youtube.com/user/antigo')).toBe(
        'user/antigo',
      );
    });

    it('os três formatos geram três URLs diferentes', () => {
      const handle = urlDaRede('youtube', '@canaldaloja');
      const custom = urlDaRede('youtube', 'c/canaldaloja');
      const canal = urlDaRede('youtube', 'channel/UCabcdefghij123');
      expect(handle).toBe('https://www.youtube.com/@canaldaloja');
      expect(custom).toBe('https://www.youtube.com/c/canaldaloja');
      expect(canal).toBe('https://www.youtube.com/channel/UCabcdefghij123');
      expect(new Set([handle, custom, canal]).size).toBe(3);
    });

    it('recusa /c/ e /channel/ sem o segundo segmento', () => {
      expect(normalizarRede('youtube', 'https://youtube.com/c/')).toBeNull();
      expect(normalizarRede('youtube', 'https://youtube.com/channel')).toBeNull();
    });

    // `montarRedes` normaliza de novo na saída, em cima do que veio do banco.
    // Se normalizar o valor já gravado mudasse o resultado, o link do vendedor
    // quebraria sozinho na primeira leitura — some no caso do `c/nome`, que tem
    // barra e seria lido como domínio.
    it('normalizar o valor já gravado não muda nada (idempotente)', () => {
      for (const entrada of [
        'https://youtube.com/@canaldaloja',
        'https://youtube.com/c/canaldaloja',
        'https://www.youtube.com/channel/UCabcdefghij123',
        'https://youtube.com/user/antigo',
      ]) {
        const primeira = normalizarRede('youtube', entrada);
        expect(primeira).not.toBeNull();
        expect(normalizarRede('youtube', primeira)).toBe(primeira);
      }
    });

    // youtu.be é encurtador de VÍDEO. Aceitá-lo faria o ícone do canal levar a
    // um 404 com o id do vídeo no lugar do nome do canal.
    it('recusa youtu.be, que é link de vídeo e não de canal', () => {
      expect(normalizarRede('youtube', 'https://youtu.be/dQw4w9WgXcQ')).toBeNull();
    });
  });

  describe('normalizarRede — segurança', () => {
    it('recusa esquema que executa script', () => {
      expect(normalizarRede('instagram', 'javascript:alert(1)')).toBeNull();
      expect(normalizarRede('instagram', 'JavaScript:alert(1)')).toBeNull();
      expect(normalizarRede('instagram', '  javascript:alert(1)')).toBeNull();
      expect(normalizarRede('instagram', 'data:text/html,<script>')).toBeNull();
      expect(normalizarRede('instagram', 'vbscript:msgbox')).toBeNull();
      expect(normalizarRede('instagram', 'file:///etc/passwd')).toBeNull();
    });

    // O navegador ignora caractere de controle ao resolver o href, então um NUL
    // no meio de "javascript:" ainda executa. Testar o texto cru deixaria
    // passar. Os caracteres são montados por CÓDIGO para não entrarem literais
    // no arquivo, onde seriam invisíveis a quem lê o teste.
    it('recusa esquema escondido atrás de caractere de controle', () => {
      const NUL = String.fromCharCode(0);
      const TAB = String.fromCharCode(9);
      expect(normalizarRede('instagram', `java${NUL}script:alert(1)`)).toBeNull();
      expect(normalizarRede('instagram', `java${TAB}script:alert(1)`)).toBeNull();
      expect(normalizarRede('instagram', `${NUL}javascript:alert(1)`)).toBeNull();
      expect(urlDeWebsite(`java${NUL}script:alert(1)`)).toBeNull();
    });

    // Lido da esquerda para a direita parece o Instagram; o navegador vai para
    // evil.com. É o motivo de a allowlist comparar `hostname`, não `startsWith`.
    it('recusa o truque do userinfo', () => {
      expect(
        normalizarRede('instagram', 'https://instagram.com@evil.com/loja'),
      ).toBeNull();
      expect(
        normalizarRede('instagram', 'https://evil.com@instagram.com/loja'),
      ).toBeNull();
    });

    it('recusa domínio de outra rede no campo errado', () => {
      expect(normalizarRede('instagram', 'https://tiktok.com/@loja')).toBeNull();
      expect(normalizarRede('tiktok', 'https://instagram.com/loja')).toBeNull();
      expect(normalizarRede('youtube', 'https://instagram.com/loja')).toBeNull();
    });

    it('recusa domínio de fora — o campo não é redirecionador aberto', () => {
      expect(normalizarRede('instagram', 'https://evil.com/loja')).toBeNull();
      expect(
        normalizarRede('instagram', 'https://instagram.com.evil.com/loja'),
      ).toBeNull();
    });

    it('recusa handle com caractere fora do permitido', () => {
      expect(normalizarRede('instagram', '@loja nerd')).toBeNull();
      expect(normalizarRede('instagram', '@loja<script>')).toBeNull();
      expect(normalizarRede('instagram', '@' + 'a'.repeat(51))).toBeNull();
    });

    it('recusa valor absurdamente longo', () => {
      expect(normalizarRede('instagram', 'a'.repeat(201))).toBeNull();
    });
  });

  describe('urlDaRede', () => {
    it('monta a URL de cada rede a partir do que foi gravado', () => {
      expect(urlDaRede('tiktok', 'lojanerd')).toBe('https://www.tiktok.com/@lojanerd');
      expect(urlDaRede('instagram', 'lojanerd')).toBe(
        'https://www.instagram.com/lojanerd',
      );
      expect(urlDaRede('youtube', '@canaldaloja')).toBe(
        'https://www.youtube.com/@canaldaloja',
      );
    });

    it('devolve null para o que não normaliza', () => {
      expect(urlDaRede('instagram', 'javascript:alert(1)')).toBeNull();
      expect(urlDaRede('instagram', null)).toBeNull();
    });
  });

  describe('urlDeWebsite — campo livre, com dados legados no banco', () => {
    it('aceita site de qualquer domínio', () => {
      expect(urlDeWebsite('https://lojanerd.com.br')).toBe('https://lojanerd.com.br/');
      expect(urlDeWebsite('lojanerd.com.br')).toBe('https://lojanerd.com.br/');
    });

    // O campo nunca teve validação e nunca foi exibido. Ao virar link clicável,
    // o que já está gravado passa a importar.
    it('sanea o lixo que pode estar gravado desde antes', () => {
      expect(urlDeWebsite('javascript:alert(1)')).toBeNull();
      expect(urlDeWebsite('meu site é esse aqui')).toBeNull();
      expect(urlDeWebsite('http://localhost:3000')).toBeNull();
      expect(urlDeWebsite('http://intranet')).toBeNull();
      expect(urlDeWebsite('https://user:senha@site.com')).toBeNull();
      expect(urlDeWebsite('')).toBeNull();
      expect(urlDeWebsite(null)).toBeNull();
    });
  });

  describe('montarRedes', () => {
    it('sem nenhuma rede, não há fileira', () => {
      expect(montarRedes({})).toBeNull();
      expect(
        montarRedes({
          socialTiktok: null,
          socialInstagram: null,
          socialYoutube: null,
          website: null,
        }),
      ).toBeNull();
    });

    // A regra combinada: cada ícone é independente. Uma rede preenchida mostra
    // uma; as outras vêm null e o front simplesmente não desenha.
    it('com uma rede só, as outras vêm null', () => {
      expect(montarRedes({ socialInstagram: 'lojanerd' })).toEqual({
        tiktok: null,
        instagram: 'https://www.instagram.com/lojanerd',
        youtube: null,
        website: null,
      });
    });

    it('com as quatro preenchidas, devolve as quatro', () => {
      expect(
        montarRedes({
          socialTiktok: 'lojanerd',
          socialInstagram: 'lojanerd',
          socialYoutube: '@canaldaloja',
          website: 'https://lojanerd.com.br',
        }),
      ).toEqual({
        tiktok: 'https://www.tiktok.com/@lojanerd',
        instagram: 'https://www.instagram.com/lojanerd',
        youtube: 'https://www.youtube.com/@canaldaloja',
        website: 'https://lojanerd.com.br/',
      });
    });

    // Saneamento na SAÍDA: o valor pode ter entrado antes desta regra existir.
    it('valor inválido gravado no banco não vira href', () => {
      expect(
        montarRedes({
          socialInstagram: 'javascript:alert(1)',
          socialTiktok: 'https://evil.com/loja',
        }),
      ).toBeNull();
    });

    it('só um website inválido também não gera fileira', () => {
      expect(montarRedes({ website: 'não é um site' })).toBeNull();
    });
  });

  describe('handlesBrutos — o que volta para os inputs das Configurações', () => {
    // O vendedor digitou "@loja" e precisa ver "@loja" ao reabrir a tela, não a
    // URL montada. É outro uso do mesmo dado.
    it('devolve o valor cru, sem montar URL', () => {
      expect(
        handlesBrutos({
          socialTiktok: 'lojanerd',
          socialInstagram: 'loja.nerd',
          socialYoutube: '@canaldaloja',
          website: 'https://lojanerd.com.br',
        }),
      ).toEqual({
        tiktok: 'lojanerd',
        instagram: 'loja.nerd',
        youtube: '@canaldaloja',
        website: 'https://lojanerd.com.br',
      });
    });

    it('campo não preenchido volta null', () => {
      expect(handlesBrutos({})).toEqual({
        tiktok: null,
        instagram: null,
        youtube: null,
        website: null,
      });
    });
  });
});
