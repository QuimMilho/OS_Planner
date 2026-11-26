import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import { ENV, type Env } from '../config/env.js';

/** Transaction client handed to `$transaction(async (tx) => ...)` callbacks. */
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

type AnyFn = () => unknown;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /** Callbacks waiting for the transaction they were registered in to commit (see `afterCommit`). */
  private readonly commitHooks = new WeakMap<object, AnyFn[]>();
  /** The clients of the interactive transactions that are running. */
  private readonly openTx = new WeakSet<object>();

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

    // Interactive transactions run the callbacks registered with `afterCommit` once they have committed
    // (and drop them when they roll back). Array transactions have no client to register on and are untouched.
    const original = this.$transaction.bind(this) as (arg: unknown, ...rest: unknown[]) => Promise<unknown>;
    const wrapped = (arg: unknown, ...rest: unknown[]): Promise<unknown> => {
      if (typeof arg !== 'function') return original(arg, ...rest);
      let client: object | undefined;
      return original(async (tx: unknown) => {
        client = tx as object;
        this.openTx.add(client);
        return (arg as (tx: unknown) => unknown)(tx);
      }, ...rest).then(
        async (result) => {
          await this.runHooks(client);
          return result;
        },
        (error: unknown) => {
          if (client) {
            this.commitHooks.delete(client);
            this.openTx.delete(client);
          }
          throw error;
        },
      );
    };
    Object.defineProperty(this, '$transaction', { value: wrapped, configurable: true, writable: true });
  }

  /**
   * Runs `fn` after the transaction `tx` commits; nothing happens if it rolls back. Outside a transaction (the plain
   * client) it runs at once. Use it to publish events about a change only when the change is really there.
   */
  afterCommit(tx: Tx | PrismaClient, fn: () => unknown): void {
    if (!this.openTx.has(tx as object)) {
      void Promise.resolve(fn()).catch(() => undefined);
      return;
    }
    const list = this.commitHooks.get(tx as object) ?? [];
    list.push(fn);
    this.commitHooks.set(tx as object, list);
  }

  /** Hooks run in order and are waited for, so a change that must be in effect before the caller answers can be. */
  private async runHooks(client: object | undefined): Promise<void> {
    if (!client) return;
    this.openTx.delete(client);
    const list = this.commitHooks.get(client);
    this.commitHooks.delete(client);
    for (const fn of list ?? []) {
      try {
        await fn();
      } catch {
        /* a hook must never turn a committed change into an error */
      }
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
