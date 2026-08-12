import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { clerkMiddleware } from '@clerk/express';
import { resumoDoBuild } from './version';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Validação global de DTOs (class-validator). transform converte tipos primitivos
  // conforme os decorators @Type; whitelist remove propriedades não declaradas no DTO.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  );

  // CORS para o MVP (Permitir requests do Front local ou prod)
  app.enableCors({
    origin: [
      'https://kolecta.com.br',
      'https://kolecta.vercel.app',
      'http://localhost:5173',
      'http://localhost:8080',
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization, x-dev-user-id',
    // Sem `exposedHeaders`, o navegador ESCONDE do JavaScript qualquer cabeçalho
    // de resposta fora da lista padrão do CORS. `X-Kolecta-Conteudo` diz se o PDF
    // baixado traz a declaração de conteúdo junto da etiqueta ou só a etiqueta
    // (a declaração é assíncrona no Melhor Envio), e o painel usa isso para
    // avisar o vendedor. Sem esta linha ele chega sempre nulo, sem erro nenhum.
    exposedHeaders: 'X-Kolecta-Conteudo',
    credentials: true,
  });

  // O Auth Middleware do Clerk preencherá o objeto `req.auth` (usado no AuthGuard)
  // Em dev (local), se a chave não existir no .env, não roda o middleware do Clerk.
  // O DevAuthMiddleware assumirá o mock completo.
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.CLERK_PUBLISHABLE_KEY
  ) {
    app.use(clerkMiddleware());
  }

  // Escutar a porta injetada pela Render (ou 3000 local) na rede 0.0.0.0
  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  // O commit no log de inicialização responde "esse deploy subiu?" sem depender
  // de rede — é a mesma informação de `GET /api/version`, disponível já na
  // primeira linha do log da Render.
  console.log(`Backend rodando na porta: ${port} · ${resumoDoBuild()}`);
}
bootstrap();
