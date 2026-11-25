import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import { ENV, type Env } from '../config/env.js';

/** Transaction client handed to `$transaction(async (tx) => ...)` callbacks. */
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    const url = new URL(env.DATABASE_URL);
    super({
      adapter: new PrismaMariaDb({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace(/^\//, ''),
        connectionLimit: 10,
        // MySQL 8 defaults to caching_sha2_password, which needs this over a non-TLS link.
        allowPublicKeyRetrieval: true,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
