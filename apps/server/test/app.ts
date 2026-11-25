import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { parseEnv } from '../src/config/env.js';
import { MailService } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

export interface SentMail {
  kind: 'verify' | 'reset';
  to: string;
  name: string;
  locale: string;
  token: string;
}

/** Captures outgoing mail so tests can follow verification and reset links. */
export class FakeMail {
  sent: SentMail[] = [];
  async sendVerification(to: string, name: string, locale: string, token: string) {
    this.sent.push({ kind: 'verify', to, name, locale, token });
    return true;
  }
  async sendPasswordReset(to: string, name: string, locale: string, token: string) {
    this.sent.push({ kind: 'reset', to, name, locale, token });
    return true;
  }
  last(kind: SentMail['kind'], to: string): SentMail | undefined {
    return [...this.sent].reverse().find((m) => m.kind === kind && m.to === to);
  }
}

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  mail: FakeMail;
  /** Plain client without cookie persistence. */
  http: ReturnType<typeof request>;
  /** Client that keeps cookies, like a browser. */
  agent(): ReturnType<typeof request.agent>;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const mail = new FakeMail();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app, parseEnv());
  await app.init();
  const server = app.getHttpServer();

  return {
    app,
    prisma: app.get(PrismaService),
    mail,
    http: request(server),
    agent: () => request.agent(server),
    close: () => app.close(),
  };
}

let counter = 0;
export const uniqueEmail = (prefix = 'user'): string => `${prefix}${Date.now()}${counter++}@example.com`;

export const GOOD_PASSWORD = 'correct horse battery';
