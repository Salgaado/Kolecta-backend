import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DATABASE_CONNECTION } from '../database/database.module';
import { PagarmeService } from '../pagarme/pagarme.service';
import { RecipientsService } from './recipients.service';
import { CreateRecipientDto } from './dto/create-recipient.dto';

/**
 * Regressão de 31/07: o cadastro de recebedor são DUAS chamadas à Pagar.me, e a
 * segunda (`kyc_link`) estava derrubando o request inteiro com 401 "IP de origem
 * não autorizado". O vendedor via "Erro ao cadastrar recebedor" para um cadastro
 * que tinha dado certo — e ficava preso, porque a retentativa só refaz a chamada
 * que falha. Os testes abaixo travam as duas metades desse comportamento.
 */
describe('RecipientsService — onboard resiste ao kyc_link falhando', () => {
  let service: RecipientsService;
  let pagarmePost: jest.Mock;
  let sellerRow: Record<string, any> | undefined;
  let updateSet: jest.Mock;

  // CPF com dígito verificador válido (isValidDocument roda antes de tudo).
  const CPF = '52998224725';

  const dto = {
    type: 'individual',
    name: 'Fulano de Tal',
    document: CPF,
    email: 'fulano@exemplo.com',
    bankAccount: { holderDocument: CPF },
  } as unknown as CreateRecipientDto;

  /** 401 igual ao que a PagarmeService propaga quando o IP é barrado. */
  const ipBlocked = () =>
    new HttpException(
      {
        message: 'Erro na comunicação com a Pagar.me',
        pagarme: {
          message: 'IP de origem não autorizado a realizar essa operação.',
        },
      },
      401,
    );

  beforeEach(async () => {
    pagarmePost = jest.fn();
    updateSet = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });

    const db = {
      select: () => ({
        from: () => ({ where: () => Promise.resolve(sellerRow ? [sellerRow] : []) }),
      }),
      update: () => ({ set: updateSet }),
      insert: () => ({
        values: () => ({ returning: () => Promise.resolve([{ userId: 'user_1' }]) }),
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RecipientsService,
        { provide: DATABASE_CONNECTION, useValue: db },
        { provide: PagarmeService, useValue: { post: pagarmePost } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(RecipientsService);
  });

  it('recebedor novo: kyc_link falhando NÃO invalida o cadastro', async () => {
    sellerRow = { userId: 'user_1', pagarmeRecipientId: null };
    pagarmePost
      .mockResolvedValueOnce({ id: 're_novo', status: 'registration' }) // POST /recipients
      .mockRejectedValueOnce(ipBlocked()); // POST /recipients/re_novo/kyc_link

    const result = await service.onboard('user_1', dto);

    // O cadastro vale e o link vem nulo — nunca uma exceção.
    expect(result.recipientId).toBe('re_novo');
    expect(result.status).toBe('registration');
    expect(result.kyc).toBeNull();

    // E o recipientId foi gravado, senão o vendedor recadastraria do zero.
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ pagarmeRecipientId: 're_novo' }),
    );
  });

  it('recebedor já existente: retentativa devolve o cadastro, não o erro', async () => {
    // Este é o estado em que os vendedores ficaram presos: o ramo "já tem
    // recebedor" não recria nada, então o kyc_link é a única chamada do request.
    sellerRow = {
      userId: 'user_1',
      pagarmeRecipientId: 're_existente',
      pagarmeRecipientStatus: 'registration',
    };
    pagarmePost.mockRejectedValueOnce(ipBlocked());

    const result = await service.onboard('user_1', dto);

    expect(result).toEqual({
      recipientId: 're_existente',
      status: 'registration',
      kyc: null,
    });
  });

  it('caminho feliz continua devolvendo o link', async () => {
    sellerRow = { userId: 'user_1', pagarmeRecipientId: null };
    pagarmePost
      .mockResolvedValueOnce({ id: 're_novo', status: 'registration' })
      .mockResolvedValueOnce({
        url: 'https://kyc.pagar.me/abc',
        base64_qrcode: 'iVBORw0KG',
        expires_at: '2026-07-31T23:00:00Z',
      });

    const result = await service.onboard('user_1', dto);

    expect(result.kyc).toEqual({
      url: 'https://kyc.pagar.me/abc',
      qrCodeBase64: 'iVBORw0KG',
      expiresAt: '2026-07-31T23:00:00Z',
    });
  });

  it('/kyc-link sob demanda falha alto, mas sem vazar o erro do gateway', async () => {
    // O vendedor via um toast vermelho com "IP de origem não autorizado" — um
    // detalhe de infraestrutura que ele não resolve e que o faz achar que está
    // travado. Gerar o link continua sendo a única função do endpoint, então
    // ele ainda falha; o que muda é 503 + instrução no lugar do 401 cru.
    sellerRow = { userId: 'user_1', pagarmeRecipientId: 're_existente' };
    pagarmePost.mockRejectedValueOnce(ipBlocked());

    const err = await service.getKycLink('user_1').catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getStatus()).toBe(503);

    const body = JSON.stringify(err.getResponse());
    expect(body).toContain('Pagar.me envia');
    // Nada de infraestrutura na cara do vendedor.
    expect(body).not.toContain('IP de origem');
  });

  it('/kyc-link sem recebedor continua 404 (não é indisponibilidade)', async () => {
    sellerRow = { userId: 'user_1', pagarmeRecipientId: null };

    await expect(service.getKycLink('user_1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(pagarmePost).not.toHaveBeenCalled();
  });
});
