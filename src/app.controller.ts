import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { infoDoBuild } from './version';
// `import type` obrigatório: o tipo aparece na assinatura de um método
// decorado, e com `isolatedModules` + `emitDecoratorMetadata` um import normal
// vira erro de compilação. Mesma pegadinha dos DTOs do projeto.
import type { InfoDoBuild } from './version';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Qual código está rodando aqui.
   *
   * SEM autenticação de propósito: o valor disto é justamente poder conferir um
   * deploy de fora, sem token — foi a falta disso que em 12/08 obrigou a sondar
   * rotas comparando 401 contra 404, técnica que nem funciona quando a mudança
   * é dentro de uma rota que já existe. O SHA não é segredo: o repositório é
   * público.
   */
  @Get('api/version')
  getVersion(): InfoDoBuild {
    return infoDoBuild();
  }
}
