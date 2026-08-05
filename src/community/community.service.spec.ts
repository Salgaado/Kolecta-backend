import {
  CommunityService,
  computePostScore,
} from './community.service';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';

const authorId = 'author_1';

const samplePost = {
  id: 'post_1',
  authorId,
  type: 'discussion',
  title: 'Olá comunidade',
  body: null,
  images: '["u1","u2"]',
  categoryId: null,
  listingId: null,
  status: 'active',
  likeCount: 0,
  saveCount: 0,
  commentCount: 0,
  pinCount: 0,
  score: 0,
  scoreUpdatedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeDb = ({
  ban = undefined,
  listing = undefined,
  category = undefined,
  inserted = samplePost,
}: {
  ban?: any;
  listing?: any;
  category?: any;
  inserted?: any;
} = {}) => ({
  query: {
    communityBans: { findFirst: jest.fn().mockResolvedValue(ban) },
    listings: { findFirst: jest.fn().mockResolvedValue(listing) },
    categories: { findFirst: jest.fn().mockResolvedValue(category) },
    communityPosts: { findFirst: jest.fn().mockResolvedValue(undefined) },
  },
  insert: jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([inserted]),
    }),
  }),
});

describe('computePostScore', () => {
  const now = Date.now();

  it('soma os pesos: likes*1 + comments*2 + saves*3 + pins*5', () => {
    const score = computePostScore(
      { likeCount: 2, commentCount: 1, saveCount: 1, pinCount: 1, createdAt: now },
      now,
    );
    // 2 + 2 + 3 + 5 = 12 (sem decay, sem reputação)
    expect(score).toBe(12);
  });

  it('aplica bônus de reputação do autor (5★ = +4)', () => {
    const score = computePostScore(
      { likeCount: 0, commentCount: 0, saveCount: 0, pinCount: 0, avgRating: 5, createdAt: now },
      now,
    );
    expect(score).toBe(4);
  });

  it('aplica penalidade de reputação (1★ = -4)', () => {
    const score = computePostScore(
      { likeCount: 0, commentCount: 0, saveCount: 0, pinCount: 0, avgRating: 1, createdAt: now },
      now,
    );
    expect(score).toBe(-4);
  });

  it('sem avgRating não aplica bônus', () => {
    const score = computePostScore(
      { likeCount: 1, commentCount: 0, saveCount: 0, pinCount: 0, avgRating: null, createdAt: now },
      now,
    );
    expect(score).toBe(1);
  });

  it('post mais antigo tem score menor (time decay)', () => {
    const base = { likeCount: 10, commentCount: 0, saveCount: 0, pinCount: 0 };
    const fresh = computePostScore({ ...base, createdAt: now }, now);
    const old = computePostScore(
      { ...base, createdAt: now - 10 * 3_600_000 },
      now,
    );
    expect(old).toBeLessThan(fresh);
    expect(fresh - old).toBeCloseTo(5); // 10h * 0.5/h
  });
});

describe('CommunityService.createPost', () => {
  it('bloqueia usuário banido (Forbidden)', async () => {
    const service = new CommunityService(makeDb({ ban: { id: 'b1' } }) as any);
    await expect(
      service.createPost(authorId, { type: 'discussion', title: 'x' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('post de produto sem listingId → BadRequest', async () => {
    const service = new CommunityService(makeDb() as any);
    await expect(
      service.createPost(authorId, { type: 'product', title: 'x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('produto inexistente → NotFound', async () => {
    const service = new CommunityService(makeDb({ listing: null }) as any);
    await expect(
      service.createPost(authorId, { type: 'product', title: 'x', listingId: 'L1' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('produto não ativo → BadRequest', async () => {
    const service = new CommunityService(
      makeDb({ listing: { id: 'L1', status: 'draft', sellerId: authorId } }) as any,
    );
    await expect(
      service.createPost(authorId, { type: 'product', title: 'x', listingId: 'L1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('produto de outro seller → Forbidden', async () => {
    const service = new CommunityService(
      makeDb({ listing: { id: 'L1', status: 'active', sellerId: 'outro' } }) as any,
    );
    await expect(
      service.createPost(authorId, { type: 'product', title: 'x', listingId: 'L1' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('cria post de produto válido e retorna images como array', async () => {
    const db = makeDb({
      listing: { id: 'L1', status: 'active', sellerId: authorId },
    });
    const service = new CommunityService(db as any);

    const result = await service.createPost(authorId, {
      type: 'product',
      title: 'Meu produto',
      listingId: 'L1',
      images: ['u1', 'u2'],
    });

    expect(result.images).toEqual(['u1', 'u2']);
    const valuesArg = (db.insert().values as jest.Mock).mock.calls[0][0];
    expect(valuesArg.listingId).toBe('L1');
    expect(valuesArg.images).toBe('["u1","u2"]');
  });

  it('cria post de discussão sem vincular produto', async () => {
    const db = makeDb();
    const service = new CommunityService(db as any);

    await service.createPost(authorId, { type: 'discussion', title: 'Debate' });

    const valuesArg = (db.insert().values as jest.Mock).mock.calls[0][0];
    expect(valuesArg.listingId).toBeNull();
  });
});

/**
 * Moderação de COMENTÁRIO.
 *
 * A coluna `status` existia em `community_comments` desde o começo e nunca teve
 * como mexer nela: só post tinha endpoint. Descoberto em 05/08/2026 com três
 * comentários no ar apontando para a loja de um concorrente, ou seja um terço
 * de tudo que havia sido comentado na comunidade.
 */
describe('CommunityService.setCommentStatus', () => {
  const comentario = { id: 'c1', postId: 'p1', status: 'active' };

  function montar(atual = 'active') {
    const updates: any[] = [];
    const db: any = {
      query: {
        communityComments: {
          findFirst: jest.fn().mockResolvedValue({ ...comentario, status: atual }),
        },
      },
      update: jest.fn(() => ({
        set: jest.fn((patch: any) => {
          updates.push(patch);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    return { db, updates, service: new CommunityService(db) };
  }

  it('oculta o comentário e desconta do contador do post', async () => {
    // Sem ajustar o contador, o post mostraria "9 comentários" numa lista com 6
    // e alguém iria caçar o bug errado.
    const { service, updates } = montar('active');

    const r = await service.setCommentStatus('c1', 'hidden');

    expect(r).toEqual({ success: true, status: 'hidden' });
    expect(updates[0]).toMatchObject({ status: 'hidden' });
    expect(updates[1]).toHaveProperty('commentCount');
  });

  it('restaurar soma de volta no contador', async () => {
    const { service, updates } = montar('removed');

    await service.setCommentStatus('c1', 'active');

    expect(updates[0]).toMatchObject({ status: 'active' });
    expect(updates[1]).toHaveProperty('commentCount');
  });

  it('repetir o mesmo status não mexe em nada', async () => {
    // Ocultar duas vezes descontaria o contador duas vezes.
    const { service, updates } = montar('hidden');

    const r = await service.setCommentStatus('c1', 'hidden');

    expect(r).toEqual({ success: true, status: 'hidden' });
    expect(updates).toHaveLength(0);
  });

  it('comentário inexistente recusa em vez de fingir que deu certo', async () => {
    const db: any = {
      query: { communityComments: { findFirst: jest.fn().mockResolvedValue(null) } },
    };
    await expect(
      new CommunityService(db).setCommentStatus('nao-existe', 'removed'),
    ).rejects.toThrow(/não encontrado/i);
  });
});
