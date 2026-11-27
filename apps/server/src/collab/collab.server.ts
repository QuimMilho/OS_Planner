import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Hocuspocus, type Extension } from '@hocuspocus/server';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { COLLAB_LIMITS, COLLAB_PATH } from '@os-planner/shared';
import { allowedOrigins, ENV, type Env } from '../config/env.js';
import { EventBus } from '../events/event-bus.js';
import { CollabRegistry, type CollabContext } from './collab.registry.js';
import { CLOSE_FORBIDDEN, CollabService, RESET } from './collab.service.js';

const PING_MS = 25_000;
/** What Hocuspocus reaches into a connection for. */
interface SocketHolder {
  webSocket: WebSocket;
}

/**
 * Owns the co-editing server: Hocuspocus (Yjs) behind a plain `ws` server on the API's own HTTP server, path /api/collab,
 * with the same origin rule as the realtime socket. Who may open which page and what is stored is CollabService's business.
 *
 * Every connection is checked again when something that decides access happens (a role, a share, a membership, a login ends)
 * and on a timer: a person who lost access is disconnected, and one whose right to type changed reconnects with the new one.
 */
@Injectable()
export class CollabServer implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(CollabServer.name);
  private hp: Hocuspocus | undefined;
  private wss: WebSocketServer | undefined;
  private httpServer: HttpServer | undefined;
  private onUpgrade: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined;
  private ping: NodeJS.Timeout | undefined;
  private sweep: NodeJS.Timeout | undefined;
  private checking: Promise<void> | null = null;
  private again = false;
  private readonly unsubscribe: (() => void)[] = [];
  private stopping = false;

  constructor(
    private readonly host: HttpAdapterHost,
    @Inject(ENV) private readonly env: Env,
    private readonly registry: CollabRegistry,
    private readonly service: CollabService,
    private readonly bus: EventBus,
  ) {}

  get usesRedis(): boolean {
    return this.env.REDIS_URL !== undefined;
  }

  /** Counts for the admin page: this instance's open pages and connections. */
  snapshot(): { documents: number; connections: number; redis: boolean } {
    return {
      documents: this.hp?.getDocumentsCount() ?? 0,
      connections: this.hp?.getConnectionsCount() ?? 0,
      redis: this.usesRedis,
    };
  }

  onModuleInit(): void {
    const extensions: Extension[] = [this.service.extension()];
    if (this.env.REDIS_URL) {
      const url = new URL(this.env.REDIS_URL);
      extensions.push(
        new RedisExtension({
          host: url.hostname,
          port: Number(url.port || 6379),
          identifier: `os-planner-${randomUUID()}`,
          prefix: 'os_planner:collab',
          options: {
            ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
            ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
            ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
            maxRetriesPerRequest: null,
          },
        }),
      );
      this.log.log('co-editing is shared between instances through Redis');
    }
    const hp = new Hocuspocus({
      name: 'os-planner',
      quiet: true,
      timeout: 30_000,
      authenticationTimeout: 10_000,
      debounce: this.env.COLLAB_DEBOUNCE_MS,
      maxDebounce: Math.max(this.env.COLLAB_MAX_DEBOUNCE_MS, this.env.COLLAB_DEBOUNCE_MS),
      unloadImmediately: true,
      extensions,
    });
    this.hp = hp;
    this.registry.hocuspocus = hp;

    const allowed = new Set(allowedOrigins(this.env));
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: COLLAB_LIMITS.messageBytes,
      perMessageDeflate: false,
    });
    this.wss = wss;
    this.httpServer = this.host.httpAdapter.getHttpServer() as HttpServer;
    // Decided synchronously: engine.io (the realtime socket) closes upgrades nobody answered within a second.
    this.onUpgrade = (req, socket, head) => {
      if ((req.url ?? '').split('?')[0] !== COLLAB_PATH) return;
      const origin = req.headers.origin;
      if (origin !== undefined && !allowed.has(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(hp, ws, req));
    };
    this.httpServer.on('upgrade', this.onUpgrade);

    this.ping = setInterval(() => {
      for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.ping();
    }, PING_MS);
    this.ping.unref();
    this.sweep = setInterval(() => void this.recheck(), this.env.COLLAB_RECHECK_MS);
    this.sweep.unref();
    for (const event of [
      'permissions.changed',
      'membership.changed',
      'session.revoked',
      'team.audited',
    ] as const) {
      this.unsubscribe.push(this.bus.subscribe(event, () => this.recheck()));
    }
  }

  private accept(hp: Hocuspocus, ws: WebSocket, req: IncomingMessage): void {
    const headers = new Headers();
    for (const name of ['origin', 'user-agent', 'x-forwarded-for']) {
      const v = req.headers[name];
      if (typeof v === 'string') headers.set(name, v);
    }
    const request = new Request(
      `http://${req.headers.host ?? 'localhost'}${req.url ?? COLLAB_PATH}`,
      { headers },
    );
    const connection = hp.handleConnection(ws, request);
    ws.on('message', (data: RawData) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data;
      connection.handleMessage(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    });
    ws.on('close', (code, reason) => connection.handleClose({ code, reason: reason.toString() }));
    ws.on('pong', () => connection.touch());
    ws.on('error', () => undefined); // a broken socket closes next; nothing a client sends can crash the server
  }

  /** Pages that predate co-editing get their live document in the background, gently, a batch at a time. */
  onApplicationBootstrap(): void {
    if (!this.env.COLLAB_MIGRATE_ON_START) return;
    void (async () => {
      let total = 0;
      for (;;) {
        if (this.stopping) return;
        const built = await this.service.migrateBatch(100);
        total += built;
        if (built === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (total) this.log.log(`built the live document of ${total} existing pages`);
    })().catch((e: unknown) =>
      this.log.warn(`batch migration stopped: ${e instanceof Error ? e.message : e}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const off of this.unsubscribe.splice(0)) off();
    clearInterval(this.ping);
    clearInterval(this.sweep);
    if (this.onUpgrade) this.httpServer?.off('upgrade', this.onUpgrade);
    const hp = this.hp;
    this.hp = undefined;
    this.registry.hocuspocus = null;
    if (hp) {
      // Edits waiting for their debounce are written now, then everybody is let go.
      hp.flushPendingStores();
      hp.closeConnections();
      for (let i = 0; i < 100 && (hp.documents.size > 0 || hp.unloadingDocuments.size > 0); i++)
        await new Promise((r) => setTimeout(r, 50));
      await hp.hooks('onDestroy', { instance: hp }).catch(() => undefined);
    }
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
  }

  // ------------------------------------------------------------------ access changes

  /** Checks every open connection against what its person may do now. Concurrent calls are folded into one more pass. */
  recheck(): Promise<void> {
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    this.checking = (async () => {
      do {
        this.again = false;
        await this.recheckAll();
      } while (this.again);
    })()
      .catch((e: unknown) => this.log.warn(`recheck failed: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  private async recheckAll(): Promise<void> {
    const hp = this.hp;
    if (!hp) return;
    for (const [pageId, doc] of [...hp.documents]) {
      for (const connection of [...doc.connections.keys()]) {
        const c = connection.context as Partial<CollabContext> | undefined;
        if (!c?.userId || !c.sessionId) continue;
        const access = (await this.service.sessionAlive(c.userId, c.sessionId))
          ? await this.service.accessTo(c.userId, pageId)
          : null;
        const code = !access ? CLOSE_FORBIDDEN : access.canEdit !== c.canEdit ? RESET : null;
        if (code) {
          this.log.log(
            `closing a connection to page ${pageId}: ${access ? 'the right to edit changed' : 'no access any more'}`,
          );
          (connection as unknown as SocketHolder).webSocket.close(code.code, code.reason);
        }
      }
    }
  }
}
