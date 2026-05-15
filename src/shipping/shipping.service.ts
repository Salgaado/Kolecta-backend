import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { QuoteShippingDto } from './dto/shipping.dto';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);
  private readonly baseUrl = process.env.MELHOR_ENVIO_API_URL || 'https://sandbox.melhorenvio.com.br/api/v2/me';
  private readonly token = process.env.MELHOR_ENVIO_TOKEN;

  constructor(private readonly httpService: HttpService) {}

  async quoteShipping(data: QuoteShippingDto) {
    if (!this.token) {
      this.logger.warn('Token do Melhor Envio não configurado. Retornando mocks para desenvolvimento.');
      return this.getMockShippingQuote();
    }

    try {
      const payload = {
        from: { postal_code: data.from_cep.replace(/\D/g, '') },
        to: { postal_code: data.to_cep.replace(/\D/g, '') },
        package: {
          weight: data.weight_kg,
          width: data.width_cm,
          height: data.height_cm,
          length: data.length_cm,
        },
      };

      const response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/shipment/calculate`, payload, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.token}`,
            'User-Agent': 'Kolecta App (contato@kolecta.com)',
          },
          timeout: 5000,
        }),
      );

      const options = response.data
        .filter((opt: any) => !opt.error)
        .map((opt: any) => ({
          carrier: opt.company.name,
          service: opt.name,
          price: parseFloat(opt.custom_price || opt.price),
          delivery_time_days: opt.custom_delivery_time || opt.delivery_time,
          raw: opt,
        }));

      return { options };
    } catch (error: any) {
      this.logger.error('Erro ao cotar frete no Melhor Envio', error?.response?.data || error.message);
      return this.getMockShippingQuote();
    }
  }

  async generateLabel(orderId: string) {
    this.logger.log(`Gerando etiqueta mockada para o pedido: ${orderId}`);
    return {
      success: true,
      message: 'Etiqueta gerada com sucesso (Mock)',
      label_url: 'https://melhorenvio.com.br/etiqueta/mock.pdf',
    };
  }

  private getMockShippingQuote() {
    return {
      options: [
        {
          carrier: 'Correios',
          service: 'PAC',
          price: 25.9,
          delivery_time_days: 7,
          raw: {},
        },
        {
          carrier: 'Correios',
          service: 'SEDEX',
          price: 45.5,
          delivery_time_days: 3,
          raw: {},
        },
      ],
    };
  }
}
