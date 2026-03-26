import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { clerkMiddleware } from '@clerk/express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // CORS para o MVP (Permitir requests do Front local ou prod)
  app.enableCors({
    origin: '*', // Ajustar para a URL do Front na etapa de deploy
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // O Auth Middleware do Clerk preencherá o objeto `req.auth` (usado no AuthGuard)
  app.use(clerkMiddleware());

  // Escutar a porta injetada pela Render (ou 3000 local) na rede 0.0.0.0
  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`Backend rodando na porta: ${port}`);
}
bootstrap();
