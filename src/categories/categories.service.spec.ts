import { CategoriesService } from './categories.service';

const mockCategories = [
  { id: 'c1', name: 'Action Figures', slug: 'action-figures', icon: '🦸', parentId: null },
  { id: 'c2', name: 'Cards Colecionáveis', slug: 'cards-colecionaveis', icon: '🃏', parentId: null },
];

describe('CategoriesService', () => {
  const makeMockDb = (results: any = mockCategories) => {
    const chain: any = {
      results,
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      then: jest.fn().mockImplementation(function (resolve: (value: any) => void) {
        return Promise.resolve(this.results).then(resolve);
      }),
    };
    return chain;
  };

  it('retorna todas as categorias ordenadas', async () => {
    const db = makeMockDb();
    const service = new CategoriesService(db as any);

    const result = await service.findAll();

    expect(result).toEqual(mockCategories);
    expect(db.select).toHaveBeenCalled();
    expect(db.orderBy).toHaveBeenCalled();
  });

  it('retorna lista vazia quando não há categorias', async () => {
    const db = makeMockDb([]);
    const service = new CategoriesService(db as any);

    await expect(service.findAll()).resolves.toEqual([]);
  });
});
