import { html, text, subject, MessageReceivedData } from './message-received';

/**
 * O aviso de nova mensagem precisa levar CADA lado para a SUA caixa de entrada.
 *
 * Comprador lê em `/conta/mensagens`; vendedor, em `/painel/mensagens`. O CTA
 * apontava para a do comprador nos dois casos. Os dois únicos avisos que a
 * plataforma chegou a mandar (25/07 e 31/07) foram para vendedores — os dois
 * caíram na caixa errada, e as duas mensagens continuavam não lidas.
 *
 * O e-mail era o único caminho até a conversa: nenhuma das telas notifica em
 * tempo real, e a caixa do vendedor não aceita `?conv=`. Link errado = mensagem
 * que não chega.
 */

const base: MessageReceivedData = {
  recipientName: 'Ana Paula',
  senderName: 'Bruno',
  excerpt: 'Boa tarde, o item ainda está disponível?',
  listingTitle: 'Skyline GT-R 1:64',
};

describe('e-mail message-received — para qual caixa o botão leva', () => {
  describe('destinatário é o VENDEDOR', () => {
    const data = { ...base, recipientIsSeller: true };

    it('leva para /painel/mensagens no HTML', () => {
      const corpo = html(data);
      expect(corpo).toContain('/painel/mensagens');
      expect(corpo).not.toContain('/conta/mensagens');
    });

    it('leva para /painel/mensagens na versão texto', () => {
      const corpo = text(data);
      expect(corpo).toContain('/painel/mensagens');
      expect(corpo).not.toContain('/conta/mensagens');
    });

    it('mantém a legenda sobre reputação, que só faz sentido para ele', () => {
      expect(html(data)).toContain('reputação de vendedor');
    });
  });

  describe('destinatário é o COMPRADOR', () => {
    const data = { ...base, recipientIsSeller: false };

    it('leva para /conta/mensagens no HTML', () => {
      const corpo = html(data);
      expect(corpo).toContain('/conta/mensagens');
      expect(corpo).not.toContain('/painel/mensagens');
    });

    it('leva para /conta/mensagens na versão texto', () => {
      const corpo = text(data);
      expect(corpo).toContain('/conta/mensagens');
      expect(corpo).not.toContain('/painel/mensagens');
    });

    it('não fala de reputação de vendedor para quem comprou', () => {
      expect(html(data)).not.toContain('reputação de vendedor');
    });
  });

  describe('compatibilidade e conteúdo', () => {
    it('sem a flag, cai na caixa do comprador (comportamento antigo)', () => {
      // Evento antigo na fila durante o deploy não pode virar link quebrado.
      const corpo = html(base);
      expect(corpo).toContain('/conta/mensagens');
    });

    it('o assunto nomeia quem escreveu', () => {
      expect(subject(base)).toBe('Bruno te mandou uma mensagem');
    });

    it('remetente desconhecido não vira "null" no assunto', () => {
      expect(subject({ ...base, senderName: null })).toBe(
        'Alguém te mandou uma mensagem',
      );
    });

    it('mostra o trecho e o anúncio, para o destinatário situar a conversa', () => {
      const corpo = html({ ...base, recipientIsSeller: true });
      expect(corpo).toContain('ainda está disponível');
      expect(corpo).toContain('Skyline GT-R 1:64');
    });

    it('escapa HTML vindo da mensagem do usuário', () => {
      const corpo = html({
        ...base,
        excerpt: '<script>alert(1)</script>',
        recipientIsSeller: true,
      });
      expect(corpo).not.toContain('<script>');
    });
  });
});
