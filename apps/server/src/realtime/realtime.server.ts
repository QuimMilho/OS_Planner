import type { Server as HttpServer } from 'node:http';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server, type DefaultEventsMap, type RemoteSocket, type Socket } from 'socket.io';
import { REALTIME_LIMITS, REALTIME_PATH, type RealtimeStatsDto } from '@os-planner/shared';
import { allowedOrigins, ENV, type Env } from '../config/env.js';

/** What the server remembers about one connection (visible to every instance through `fetchSockets`). */
export interface SocketData {
  userId: string;
  /** The login (refresh-token family) the access token came from. */
  sessionId: string;
  /** When the access token behind this connection stops being valid (ms since the epoch). */
  expiresAt: number;
  /** Last time the page said it was in use (ms). */
  lastActivity: number;
  /** The idle transition has been announced for this connection. */
  idle: boolean;
  /** The channel or conversation this page is showing right now (set by the page), or null. */
  focus?: string | null;
}

export type RtSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
export type RtRemoteSocket = RemoteSocket<DefaultEventsMap, SocketData>;

export const userRoom = (userId: string): string => `user:${userId}`;
export const teamRoom = (teamId: string): string => `team:${teamId}`;

/**
 * Owns the Socket.IO server and nothing else: it is attached to the same HTTP server as the API (path /api/realtime),
 * refuses origins other than APP_URL and CORS_ORIGINS, and uses Redis to share rooms between server instances when
 * `REDIS_URL` is set. The rules of who connects and what they may do live in RealtimeGateway.
 */
@Injectable()
export class RealtimeServer implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RealtimeServer.name);
  private server: Server | undefined;
  private pub: Redis | undefined;
  private sub: Redis | undefined;

  readonly stats = {
    dropped: { unknown: 0, invalid: 0, rateLimited: 0 },
    refused: {} as Record<string, number>,
  };

  constructor(
    private readonly host: HttpAdapterHost,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The Socket.IO server. Throws before the application has started. */
  get io(): Server {
    if (!this.server) throw new Error('realtime server not started');
    return this.server;
  }

  get started(): boolean {
    return this.server !== undefined;
  }

  get usesRedis(): boolean {
    return this.pub !== undefined;
  }

  /** `ok` while everything the configuration asks for works; `degraded` when it does not (Redis down, or not started). */
  get health(): 'ok' | 'degraded' {
    if (!this.server) return 'degraded';
    if (this.pub && (this.pub.status !== 'ready' || this.sub?.status !== 'ready'))
      return 'degraded';
    return 'ok';
  }

  refuse(reason: string): void {
    this.stats.refused[reason] = (this.stats.refused[reason] ?? 0) + 1;
  }

  onModuleInit(): void {
    const httpServer = this.host.httpAdapter.getHttpServer() as HttpServer;
    const allowed = new Set(allowedOrigins(this.env));

    const server = new Server(httpServer, {
      path: REALTIME_PATH,
      serveClient: false,
      // Websocket first; long polling stays available for proxies that do not pass upgrades.
      transports: ['websocket', 'polling'],
      maxHttpBufferSize: REALTIME_LIMITS.payloadBytes,
      cors: { origin: [...allowed], credentials: true },
      // Browsers always send Origin; a page of another origin must not be able to open a socket with a stolen token.
      // Clients that are not browsers send none and are held to the token alone.
      allowRequest: (req, callback) => {
        const origin = req.headers.origin;
        if (origin !== undefined && !allowed.has(origin)) {
          this.refuse('origin_not_allowed');
          callback('origin_not_allowed', false);
          return;
        }
        callback(null, true);
      },
    });

    if (this.env.REDIS_URL) {
      const options = { maxRetriesPerRequest: null, enableReadyCheck: true } as const;
      this.pub = new Redis(this.env.REDIS_URL, options);
      this.sub = this.pub.duplicate();
      for (const client of [this.pub, this.sub])
        client.on('error', (e: Error) => this.log.warn(`redis: ${e.message}`));
      // The adapter fires commands and drops the promises: while Redis is down, or when the connection closes at shutdown,
      // they reject with nobody listening. A handler of our own on the same promise keeps that from becoming a crash.
      for (const client of [this.pub, this.sub]) {
        const send = client.sendCommand.bind(client) as (...args: unknown[]) => unknown;
        (client as unknown as { sendCommand: unknown }).sendCommand = (...args: unknown[]) => {
          const result = send(...args);
          if (result instanceof Promise) result.catch(() => undefined);
          return result;
        };
      }
      server.adapter(createAdapter(this.pub, this.sub));
      this.log.log('realtime events are shared between instances through Redis');
    }
    this.server = server;
  }

  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.disconnectSockets(true);
      // Closing also closes the HTTP server, which the application closes itself: ignore "not running".
      await new Promise<void>((done) => void server.close(() => done()));
    }
    for (const client of [this.pub, this.sub]) {
      try {
        client?.disconnect();
      } catch {
        /* already closed */
      }
    }
  }

  /** Sends `name` to everyone in `rooms` (on every instance), except the people in `except` rooms. */
  emit(rooms: string | string[], name: string, payload: unknown, except?: string[]): void {
    if (!this.server) return;
    let target = this.server.to(rooms);
    if (except?.length) target = target.except(except);
    target.emit(name, payload);
  }

  async socketsIn(room: string): Promise<RtRemoteSocket[]> {
    if (!this.server) return [];
    return (await this.server.in(room).fetchSockets()) as unknown as RtRemoteSocket[];
  }

  /** Counts for the admin page: this instance's connections and rooms. */
  snapshot(): RealtimeStatsDto {
    const server = this.server;
    const users = new Set<string>();
    let sockets = 0;
    if (server) {
      for (const s of server.of('/').sockets.values()) {
        sockets++;
        users.add((s.data as SocketData).userId);
      }
    }
    // Every socket sits in a room of its own; those are not counted.
    const rooms = server
      ? [...server.of('/').adapter.rooms.keys()].filter((r) => !server.of('/').sockets.has(r))
          .length
      : 0;
    return {
      sockets,
      rooms,
      users: users.size,
      redis: this.usesRedis,
      dropped: { ...this.stats.dropped },
      refused: { ...this.stats.refused },
    };
  }
}
