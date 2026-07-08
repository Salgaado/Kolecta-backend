import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { HttpException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { PagarmeService } from './pagarme.service';
import { PagarmeConfigService } from './pagarme-config.service';

describe('PagarmeService', () => {
  let service: PagarmeService;
  let httpRequest: jest.Mock;

  const expectedAuth = 'Basic ' + Buffer.from('sk_test_abc:').toString('base64');

  beforeAll(() => {
    process.env.PAGARME_SECRET_KEY = 'sk_test_abc';
    process.env.PAGARME_BASE_URL = 'https://api.pagar.me/core/v5';
  });

  beforeEach(async () => {
    httpRequest = jest.fn();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PagarmeService,
        PagarmeConfigService,
        { provide: HttpService, useValue: { request: httpRequest } },
      ],
    }).compile();

    service = moduleRef.get(PagarmeService);
  });

  it('POST envia auth Basic, User-Agent e Idempotency-Key e retorna data', async () => {
    httpRequest.mockReturnValue(of({ data: { id: 'or_1' } }));

    const result = await service.post('/orders', { foo: 'bar' }, 'order-1');

    expect(result).toEqual({ id: 'or_1' });
    const cfg = httpRequest.mock.calls[0][0];
    expect(cfg.method).toBe('POST');
    expect(cfg.url).toBe('https://api.pagar.me/core/v5/orders');
    expect(cfg.data).toEqual({ foo: 'bar' });
    expect(cfg.headers['User-Agent']).toBe('pagarme-skill-generated/1.0');
    expect(cfg.headers['Idempotency-Key']).toBe('order-1');
    expect(cfg.headers.Authorization).toBe(expectedAuth);
  });

  it('GET monta URL, repassa params e não inclui Idempotency-Key', async () => {
    httpRequest.mockReturnValue(of({ data: [{ id: 'rp_1' }] }));

    const result = await service.get('/recipients', { page: 1 });

    expect(result).toEqual([{ id: 'rp_1' }]);
    const cfg = httpRequest.mock.calls[0][0];
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe('https://api.pagar.me/core/v5/recipients');
    expect(cfg.params).toEqual({ page: 1 });
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('normaliza barras entre baseUrl e path', async () => {
    httpRequest.mockReturnValue(of({ data: {} }));

    await service.get('recipients/rp_1');

    expect(httpRequest.mock.calls[0][0].url).toBe(
      'https://api.pagar.me/core/v5/recipients/rp_1',
    );
  });

  it('mapeia erro da Pagar.me para HttpException preservando status e payload', async () => {
    httpRequest.mockReturnValue(
      throwError(() => ({
        response: { status: 422, data: { message: 'type is required' } },
      })),
    );

    await expect(service.post('/orders', {})).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('lança erro explícito quando a secret key não está configurada', async () => {
    delete process.env.PAGARME_SECRET_KEY;

    await expect(service.get('/recipients')).rejects.toThrow(
      'PAGARME_SECRET_KEY',
    );

    process.env.PAGARME_SECRET_KEY = 'sk_test_abc';
  });
});
