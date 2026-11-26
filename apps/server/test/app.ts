import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { parseEnv } from '../src/config/env.js';
import { MailService } from '../src/mail/mail.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

export interface SentMail {
  kind: 'verify' | 'reset' | 'invite' | 'decision' | 'ownership';
  to: string;
  name: string | null;
  locale: string;
  /** The secret in the link (verify, reset, invite); empty for the others. */
  token: string;
  team?: string;
  approved?: boolean;
  ownership?: 'offered' | 'assigned';
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
  async sendInvite(to: string, locale: string, inviter: string, team: string, token: string) {
    this.sent.push({ kind: 'invite', to, name: inviter, locale, token, team });
    return true;
  }
  async sendRequestDecision(to: string, name: string, locale: string, team: string, approved: boolean) {
    this.sent.push({ kind: 'decision', to, name, locale, token: '', team, approved });
    return true;
  }
  async sendOwnership(to: string, name: string | null, locale: string, team: string, ownership: 'offered' | 'assigned') {
    this.sent.push({ kind: 'ownership', to, name, locale, token: '', team, ownership });
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

/** `customize` may replace providers (for example the QuotaPolicy) before the module compiles. */
export async function createTestApp(customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder): Promise<TestApp> {
  const mail = new FakeMail();
  let builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailService).useValue(mail);
  if (customize) builder = customize(builder);
  const moduleRef = await builder.compile();

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
