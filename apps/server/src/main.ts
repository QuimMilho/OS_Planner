import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { loadDotEnv, parseEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  loadDotEnv();
  const env = parseEnv();

  // Body parsing is configured in configureApp so documents get their own size limit.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app, env);

  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`Notes API listening on ${env.APP_URL.startsWith('https') ? 'port' : 'http://localhost:'}${env.PORT}`);
}

void bootstrap();
