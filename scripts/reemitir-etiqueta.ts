/**
 * Reemite a etiqueta de um pedido, opcionalmente TROCANDO a transportadora.
 *
 * Existe porque o botão "tentar de novo" do painel reusa o serviço gravado no
 * pedido — e quando a falha é a própria transportadora recusando ("Esta
 * transportadora não aceita envios não-comerciais partindo deste estado"),
 * tentar de novo é tentar o mesmo "não". Sem isto, um pedido pago fica sem
 * etiqueta até alguém mexer no banco na mão.
 *
 * A emissão GASTA DINHEIRO de verdade da carteira do Melhor Envio, então o
 * padrão é ENSAIO: sem `--confirmar` nada é escrito nem comprado, só mostrado.
 *
 *   npx ts-node --transpile-only scripts/reemitir-etiqueta.ts <orderId>
 *   npx ts-node --transpile-only scripts/reemitir-etiqueta.ts <orderId> --servico=2
 *   npx ts-node --transpile-only scripts/reemitir-etiqueta.ts <orderId> --servico=2 --confirmar
 *
 * `--sem-emitir` troca o serviço e para por aí. É o modo certo quando se roda da
 * máquina de alguém: o e-mail com o PDF depende do MailService, que só está
 * ligado no Render (`MAIL_ENABLED` + `RESEND_API_KEY`). Emitir daqui compraria a
 * etiqueta e deixaria o vendedor sem aviso nenhum. Trocando aqui, a emissão sai
 * pelo "tentar de novo" do painel, em produção, com e-mail e tudo.
 *
 * Sobe só o ShippingModule (mais DatabaseModule e os eventos), não o AppModule
 * inteiro: o AppModule registra os crons, e um deles rodando da máquina de
 * alguém contra a produção é efeito colateral que ninguém pediu.
 */
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import {
  DatabaseModule,
  DATABASE_CONNECTION,
} from '../src/database/database.module';
import { ShippingModule } from '../src/shipping/shipping.module';
import { ShippingService } from '../src/shipping/shipping.service';
import { nomeDoServico } from '../src/shipping/servicos';
import * as schema from '../src/database/schema';

@Module({
  imports: [DatabaseModule, EventEmitterModule.forRoot(), ShippingModule],
})
class ScriptModule {}

const args = process.argv.slice(2);
const orderId = args.find((a) => !a.startsWith('--'));
const servicoArg = args.find((a) => a.startsWith('--servico='));
const confirmar = args.includes('--confirmar');
const semEmitir = args.includes('--sem-emitir');
const servicoNovo = servicoArg ? Number(servicoArg.split('=')[1]) : null;

const reais = (centavos: number | null | undefined) =>
  `R$ ${((centavos ?? 0) / 100).toFixed(2)}`;

/** Saldo da carteira do Melhor Envio — etiqueta sem saldo falha no checkout. */
async function saldoDoMelhorEnvio(): Promise<string> {
  const base =
    process.env.MELHOR_ENVIO_API_URL ||
    'https://sandbox.melhorenvio.com.br/api/v2/me';
  try {
    const res = await fetch(`${base}/balance`, {
      headers: {
        Authorization: `Bearer ${process.env.MELHOR_ENVIO_TOKEN}`,
        Accept: 'application/json',
        'User-Agent': 'Kolecta (contato@kolecta.com.br)',
      },
    });
    if (!res.ok) return `não consultado (HTTP ${res.status})`;
    const data: any = await res.json();
    return `R$ ${Number(data?.balance ?? 0).toFixed(2)}`;
  } catch (err: any) {
    return `não consultado (${err?.message})`;
  }
}

(async () => {
  if (!orderId) {
    console.error(
      'Uso: reemitir-etiqueta.ts <orderId> [--servico=<id>] [--confirmar]',
    );
    process.exit(1);
  }
  if (servicoArg && !Number.isFinite(servicoNovo)) {
    console.error(`--servico inválido: "${servicoArg}"`);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(ScriptModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const db: any = app.get(DATABASE_CONNECTION);
    const shipping = app.get(ShippingService);

    const pedido = await db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });
    if (!pedido) {
      console.error(`Pedido ${orderId} não encontrado.`);
      process.exit(1);
    }

    console.log('\n── Pedido ──────────────────────────────────────────────');
    console.log(`  id .................. ${pedido.id}`);
    console.log(`  status .............. ${pedido.status}`);
    console.log(
      `  entrega ............. ${pedido.deliveryMethod ?? 'shipping'}`,
    );
    console.log(
      `  serviço atual ....... ${pedido.shippingServiceName ?? '(nenhum)'}` +
        ` (id ${pedido.shippingServiceId ?? '—'})`,
    );
    console.log(`  frete pago .......... ${reais(pedido.shippingInCents)}`);
    console.log(
      `  etiqueta ............ ${pedido.shippingLabelStatus ?? '(nunca emitida)'}`,
    );
    if (pedido.shippingLabelError) {
      console.log(`  último erro ......... ${pedido.shippingLabelError}`);
    }
    console.log(
      `  carrinho ME ......... ${pedido.shippingCartId ?? '(nenhum)'}`,
    );
    console.log(`\n  saldo Melhor Envio .. ${await saldoDoMelhorEnvio()}`);

    const trocar =
      servicoNovo !== null && servicoNovo !== pedido.shippingServiceId;
    if (trocar) {
      console.log(
        `\n  TROCA: ${pedido.shippingServiceName ?? '(nenhum)'} → ` +
          `${nomeDoServico(servicoNovo)} (id ${servicoNovo})`,
      );
      console.log(
        '  A diferença de preço, se houver, fica com a Kolecta: o comprador já\n' +
          '  pagou um frete fechado e não se cobra a mais depois da compra.',
      );
    }

    if (!confirmar) {
      console.log(
        '\n── ENSAIO ──────────────────────────────────────────────\n' +
          '  Nada foi escrito nem comprado. Rode de novo com --confirmar\n' +
          '  para trocar o serviço, comprar a etiqueta na carteira do Melhor\n' +
          '  Envio e mandar o PDF ao vendedor.\n' +
          '  Acrescente --sem-emitir para só trocar o serviço.',
      );
      return;
    }

    if (trocar) {
      await db
        .update(schema.orders)
        .set({
          shippingServiceId: servicoNovo,
          shippingServiceName: nomeDoServico(servicoNovo),
          // Limpa o erro antigo: ele é da transportadora que saiu, e deixá-lo
          // faria a tela do vendedor acusar uma falha que não existe mais.
          shippingLabelError: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.orders.id, orderId));
      console.log(`\n  Serviço trocado para ${nomeDoServico(servicoNovo)}.`);
    }

    if (semEmitir) {
      console.log(
        '\n  --sem-emitir: parei aqui. A etiqueta sai pelo "tentar de novo" do\n' +
          '  painel (vendedor ou admin), em produção, com o PDF por e-mail.',
      );
      return;
    }

    console.log('\n  Emitindo…');
    const r = await shipping.emitirEtiquetaDoPedido(orderId);

    console.log('\n── Resultado ───────────────────────────────────────────');
    console.log(`  status .............. ${r.status}`);
    console.log(`  carrinho ME ......... ${r.cartId ?? '—'}`);
    console.log(`  rastreio ............ ${r.trackingCode ?? '(ainda não)'} `);
    console.log(`  PDF ................. ${r.labelUrl ? 'gerado' : '—'}`);
    console.log(
      `  já estava pronta .... ${r.jaEstavaPronta ? 'sim (nada foi gasto)' : 'não'}`,
    );

    // O e-mail com o PDF sai por evento (`shipping.label.ready`). Fechar o
    // contexto agora mataria o envio no meio — daí a espera.
    console.log('\n  Aguardando o e-mail da etiqueta sair…');
    await new Promise((r) => setTimeout(r, 10000));
  } catch (err: any) {
    console.error(
      `\n  FALHOU: ${err?.response?.message ?? err?.message ?? err}`,
    );
    if (err?.response?.details) {
      console.error(`  detalhe: ${JSON.stringify(err.response.details)}`);
    }
    process.exitCode = 1;
  } finally {
    await app.close();
  }
})();
