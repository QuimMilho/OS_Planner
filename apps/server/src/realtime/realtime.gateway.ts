import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  authRefreshSchema,
  CLIENT_EVENTS,
  IDLE_AFTER_MS,
  presenceActivitySchema,
  REALTIME_LIMITS,
  roomJoinSchema,
  SERVER_EVENTS,
  type Ack,
} from '@os-planner/shared';
import type { ZodType } from 'zod';
import { TokenService } from '../auth/token.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PresenceService } from './presence.service.js';
import { RoomAuthorizer } from './room-authorizer.js';
import { RealtimeServer, teamRoom, userRoom, type RtSocket } from './realtime.server.js';

const KNOWN_EVENTS = new Set<string>(CLIENT_EVENTS);
/** Rate limit per connection: a burst of this many events, refilling at `eventsPerSecond`. */
const BURST = REALTIME_LIMITS.eventsPerSecond * 2;
const SWEEP_MS = 30_000;

type AckFn = (ack: Ack) => void;
const ackOf = (maybe: unknown): AckFn =>
  typeof maybe === 'function' ? (maybe as AckFn) : () => undefined;

/**
 * Who may connect and what a connection may do.
 *
 *  - The handshake carries an access token (never a media token). A person has at most five connections.
 *  - The server puts the connection in `user:<id>` and in `team:<id>` for each team; everything else is a room the
 *    client asked for and the RoomAuthorizer allowed.
 *  - A connection lives as long as its token: `auth:refresh` brings a new one, and without it the connection closes.
 *  - Unknown events, malformed payloads and floods are dropped and counted; nothing a client sends can crash the server.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly expiry = new Map<string, NodeJS.Timeout>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private sweep: NodeJS.Timeout | undefined;

  constructor(
    private readonly rt: RealtimeServer,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly rooms: RoomAuthorizer,
    private readonly presence: PresenceService,
  ) {}

  onApplicationBootstrap(): void {
    const io = this.rt.io;

    io.use((socket, next) => {
      void this.authenticate(socket as unknown as RtSocket)
        .then(() => next())
        .catch((e: unknown) => {
          const reason = e instanceof Error ? e.message : 'unauthorized';
          this.rt.refuse(reason);
          next(new Error(reason));
        });
    });
    io.on('connection', (socket) => void this.onConnection(socket as unknown as RtSocket));

    // Idle is the passing of time, not an event: look for connections that crossed the line.
    this.sweep = setInterval(() => void this.sweepIdle(), SWEEP_MS);
    this.sweep.unref();
  }

  onModuleDestroy(): void {
    if (this.sweep) clearInterval(this.sweep);
    for (const timer of this.expiry.values()) clearTimeout(timer);
    this.expiry.clear();
  }

  // ---------------------------------------------------------------- handshake

  /** Is this login still alive? (A signed-out session's access token stays valid until it expires on its own.) */
  private async sessionAlive(userId: string, sessionId: string): Promise<boolean> {
    const live = await this.prisma.refreshToken.findFirst({
      where: { userId, familyId: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return live !== null;
  }

  private async authenticate(socket: RtSocket): Promise<void> {
    const raw = (socket.handshake.auth as Record<string, unknown> | undefined)?.['token'];
    // `verifyAccess` only accepts the access-token audience, so a media token (or any other JWT) is refused here.
    const user =
      typeof raw === 'string' && raw.length < 4000 ? await this.tokens.verifyAccess(raw) : null;
    if (!user?.expiresAt || !(await this.sessionAlive(user.id, user.sessionId)))
      throw new Error('unauthorized');

    const open = await this.rt.socketsIn(userRoom(user.id));
    if (open.length >= REALTIME_LIMITS.socketsPerUser) throw new Error('too_many_connections');

    socket.data = {
      userId: user.id,
      sessionId: user.sessionId,
      expiresAt: user.expiresAt * 1000,
      lastActivity: Date.now(),
      idle: false,
    };
  }

  private async onConnection(socket: RtSocket): Promise<void> {
    const { userId } = socket.data;
    this.buckets.set(socket.id, { tokens: BURST, at: Date.now() });
    this.watchExpiry(socket);

    // Every incoming packet passes here first: unknown events and floods never reach a handler.
    socket.use((packet, next) => {
      const name = packet[0];
      if (typeof name !== 'string' || !KNOWN_EVENTS.has(name)) {
        this.rt.stats.dropped.unknown++;
        return; // dropped: no handler, no reply
      }
      if (!this.takeToken(socket.id)) {
        this.rt.stats.dropped.rateLimited++;
        const ack = packet[packet.length - 1];
        if (typeof ack === 'function') (ack as AckFn)({ ok: false });
        return;
      }
      next();
    });

    socket.on(
      'room:join',
      (payload: unknown, ack?: unknown) =>
        void this.guard(payload, ack, roomJoinSchema, (p) => this.join(socket, p.kind, p.id)),
    );
    socket.on(
      'room:leave',
      (payload: unknown, ack?: unknown) =>
        void this.guard(payload, ack, roomJoinSchema, (p) => {
          void socket.leave(`${p.kind}:${p.id}`);
          return true;
        }),
    );
    socket.on(
      'auth:refresh',
      (payload: unknown, ack?: unknown) =>
        void this.guard(payload, ack, authRefreshSchema, (p) => this.refreshToken(socket, p.token)),
    );
    socket.on(
      'presence:activity',
      (payload: unknown, ack?: unknown) =>
        void this.guard(payload, ack, presenceActivitySchema, (p) => {
          if (p && 'focus' in p) socket.data.focus = p.focus ?? null;
          if (p?.active === false) return true;
          socket.data.lastActivity = Date.now();
          if (socket.data.idle) {
            socket.data.idle = false;
            void this.presence.refresh(userId);
          }
          return true;
        }),
    );
    socket.on('disconnect', () => {
      const timer = this.expiry.get(socket.id);
      if (timer) clearTimeout(timer);
      this.expiry.delete(socket.id);
      this.buckets.delete(socket.id);
      void this.presence.refresh(userId);
    });

    await socket.join(userRoom(userId));
    for (const teamId of await this.rooms.teamIds(userId)) await socket.join(teamRoom(teamId));
    void this.presence.refresh(userId);
  }

  /** Validates a payload, runs the handler and answers `{ok}`; a bad payload or a failing handler is counted, never thrown. */
  private async guard<T>(
    payload: unknown,
    maybeAck: unknown,
    schema: ZodType<T>,
    run: (payload: T) => boolean | Promise<boolean>,
  ): Promise<void> {
    const ack = ackOf(maybeAck);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.rt.stats.dropped.invalid++;
      return ack({ ok: false });
    }
    try {
      ack({ ok: await run(parsed.data) });
    } catch (e) {
      this.log.warn(`realtime handler failed: ${e instanceof Error ? e.message : e}`);
      ack({ ok: false });
    }
  }

  private takeToken(socketId: string): boolean {
    const bucket = this.buckets.get(socketId);
    if (!bucket) return false;
    const now = Date.now();
    bucket.tokens = Math.min(
      BURST,
      bucket.tokens + ((now - bucket.at) / 1000) * REALTIME_LIMITS.eventsPerSecond,
    );
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // ---------------------------------------------------------------- rooms

  /** The answer is the same `false` for a room that does not exist and one the person may not see. */
  private async join(socket: RtSocket, kind: string, id: string): Promise<boolean> {
    const room = `${kind}:${id}`;
    if (socket.rooms.has(room)) return true;
    // user and team rooms count too: leave the rest for rooms the client picked.
    if (socket.rooms.size >= REALTIME_LIMITS.roomsPerSocket) return false;
    if (!(await this.rooms.canJoin(socket.data.userId, kind, id))) return false;
    await socket.join(room);
    return true;
  }

  // ---------------------------------------------------------------- token lifetime

  private watchExpiry(socket: RtSocket): void {
    const previous = this.expiry.get(socket.id);
    if (previous) clearTimeout(previous);
    const wait = Math.max(0, socket.data.expiresAt - Date.now());
    const timer = setTimeout(() => {
      this.rt.refuse('token_expired');
      socket.emit(SERVER_EVENTS.sessionRevoked, { reason: 'revoked' });
      socket.disconnect(true);
    }, wait);
    timer.unref();
    this.expiry.set(socket.id, timer);
  }

  /** A new access token for the same login extends the connection; anything else ends it. */
  private async refreshToken(socket: RtSocket, token: string): Promise<boolean> {
    const user = await this.tokens.verifyAccess(token);
    const valid =
      user?.expiresAt !== undefined &&
      user.id === socket.data.userId &&
      user.sessionId === socket.data.sessionId &&
      (await this.sessionAlive(user.id, user.sessionId));
    if (!valid || !user?.expiresAt) {
      // Answer first, then hang up (a closed connection never delivers the answer).
      setImmediate(() => socket.disconnect(true));
      return false;
    }
    socket.data.expiresAt = user.expiresAt * 1000;
    this.watchExpiry(socket);
    return true;
  }

  // ---------------------------------------------------------------- idle

  private async sweepIdle(): Promise<void> {
    if (!this.rt.started) return;
    const now = Date.now();
    const users = new Set<string>();
    for (const socket of this.rt.io.of('/').sockets.values()) {
      const data = socket.data as RtSocket['data'];
      if (!data.idle && now - data.lastActivity >= IDLE_AFTER_MS) {
        data.idle = true;
        users.add(data.userId);
      }
    }
    for (const userId of users) await this.presence.refresh(userId, now);
  }
}
