import { Injectable, inject, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import type { Socket } from 'socket.io-client';
import { REALTIME_PATH, roomName, type RoomKind } from '@os-planner/shared/lite';
import { apiBase } from './api-config';
import { AuthStore } from './auth-store';

export type RealtimeStatus = 'connected' | 'connecting' | 'offline';

/** A page hidden this long stops listening to busy rooms (chat); it keeps the quiet ones for notifications. */
const HIDDEN_LEAVE_MS = 60_000;
/** The page tells the server it is in use at most this often. */
const ACTIVITY_MS = 30_000;
/** A new access token is fetched this long before the old one runs out, so the connection is never without one. */
const REFRESH_BEFORE_MS = 60_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Rooms that carry a lot of traffic: left while the page is hidden. */
const HEAVY: ReadonlySet<RoomKind> = new Set<RoomKind>(['channel', 'thread']);

/**
 * The page's one realtime connection (Socket.IO to /api/realtime on the API's origin).
 *
 *  - It connects while there is a signed-in session with an access token, and carries that token; a fresh token is
 *    sent with `auth:refresh` whenever there is one, so the connection outlives any single token.
 *  - Rooms are reference counted: every feature that needs a room calls `join()` and calls the returned function when
 *    done. After a reconnect the rooms are joined again and `resumed` fires: the server does not replay what was missed,
 *    so each feature fetches what changed since its own cursor.
 *  - It reconnects with exponential backoff and jitter, and shows `status` for the indicator in the top bar.
 */
@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private readonly auth = inject(AuthStore);

  readonly status = signal<RealtimeStatus>('offline');
  /** Fires after every reconnect, once the rooms are joined again. Features catch up with the server here. */
  readonly resumed = new Subject<void>();

  private socket: Socket | null = null;
  private connecting = false;
  private everConnected = false;
  private readonly refs = new Map<string, number>();
  /** Rooms the server accepted on the current connection. */
  private readonly joined = new Set<string>();
  /** Rooms the server refused (the person may not see them yet); tried again when permissions change. */
  private readonly denied = new Set<string>();
  /** Heavy rooms left because the page was hidden. */
  private readonly suspended = new Set<string>();
  private readonly subjects = new Map<string, Subject<unknown>>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private lastActivity = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  /** The network was lost since the connection last proved itself. */
  private suspect = false;
  /** The channel the page is showing (so the server need not push about it). */
  private focus: string | null = null;

  constructor() {
    this.auth.tokenChanged.subscribe((token) => (token ? this.onToken(token) : this.disconnect()));
    // The session may have started before anybody asked for this service (a reload resumes it at start-up).
    const existing = this.auth.getToken();
    if (existing) this.onToken(existing);
    addEventListener('online', () => this.reconnectNow());
    addEventListener('offline', () => this.networkLost());
    document.addEventListener('visibilitychange', () => this.onVisibility());
    for (const type of ['pointerdown', 'keydown'])
      addEventListener(type, () => this.ping(), { passive: true });
  }

  // ---------------------------------------------------------------- what features use

  /** The events of one name, as they arrive. Subscribing does not need a connection yet. */
  on<T = unknown>(event: string): Observable<T> {
    return this.subject(event).asObservable() as Observable<T>;
  }

  /** Tells the server which channel (or conversation) this page is showing, or null when none. */
  setFocus(channelId: string | null): void {
    if (this.focus === channelId) return;
    this.focus = channelId;
    if (this.socket?.connected) this.socket.emit('presence:activity', { active: true, focus: channelId });
  }

  /** Be in this room for as long as the returned function has not been called. Safe to call before connecting. */
  join(kind: RoomKind, id: string): () => void {
    const room = roomName(kind, id);
    const count = this.refs.get(room) ?? 0;
    this.refs.set(room, count + 1);
    if (count === 0) this.enter(room);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.refs.get(room) ?? 1) - 1;
      if (left > 0) return void this.refs.set(room, left);
      this.refs.delete(room);
      this.denied.delete(room);
      this.suspended.delete(room);
      if (this.joined.delete(room)) this.socket?.emit('room:leave', parseRoom(room));
    };
  }

  // ---------------------------------------------------------------- connection

  private onToken(token: string): void {
    if (this.socket) {
      // Already connected (or trying): a connected socket is handed the new token; a trying one reads it by itself.
      if (this.socket.connected) this.socket.emit('auth:refresh', { token });
      this.scheduleTokenRefresh();
      return;
    }
    void this.open();
  }

  private async open(): Promise<void> {
    if (this.socket || this.connecting) return;
    this.connecting = true;
    this.status.set(navigator.onLine ? 'connecting' : 'offline');
    try {
      const { io } = await import('socket.io-client');
      if (!this.auth.getToken() || this.socket) return;

      // The API's origin; a path on it (an API mounted under a prefix) goes in front of the socket path.
      const base = new URL(apiBase() || location.origin, location.href);
      const socket = io(base.origin, {
        path: base.pathname.replace(/\/+$/, '') + REALTIME_PATH,
        transports: ['websocket', 'polling'],
        auth: (cb) => cb({ token: this.auth.getToken() }),
        // Exponential backoff with jitter, built in.
        reconnectionDelay: RETRY_MIN_MS,
        reconnectionDelayMax: RETRY_MAX_MS,
        randomizationFactor: 0.5,
      });
      this.socket = socket;
      // Browsers do not always announce that the network is back (and the library backs off for up to 30 s between
      // attempts): look every couple of seconds, and start over as soon as the network answers.
      this.watchdog = setInterval(() => {
        if (this.socket && navigator.onLine && this.status() === 'offline') this.reconnectNow();
      }, 2_000);
      for (const [event, subject] of this.subjects)
        socket.on(event, (payload: unknown) => subject.next(payload));

      socket.on('connect', () => void this.onConnect());
      socket.on('disconnect', (reason) => this.onDisconnect(reason));
      socket.on('connect_error', (error) => void this.onError(error));
      socket.on('permissions.changed', () => this.retryDenied());
    } finally {
      this.connecting = false;
    }
  }

  private async onConnect(): Promise<void> {
    this.retries = 0;
    this.suspect = false;
    this.status.set('connected');
    this.joined.clear();
    this.scheduleTokenRefresh();
    if (this.focus) this.socket?.emit('presence:activity', { active: true, focus: this.focus });
    await Promise.all(
      [...this.refs.keys()]
        .filter((room) => !this.suspended.has(room))
        .map((room) => this.send(room)),
    );
    if (this.everConnected) this.resumed.next();
    this.everConnected = true;
  }

  private onDisconnect(reason: string): void {
    this.joined.clear();
    this.status.set(navigator.onLine ? 'connecting' : 'offline');
    // "io server disconnect" is the server closing the connection (token ran out, signed out): the client does not retry
    // by itself then. A fresh token usually fixes it.
    if (reason === 'io server disconnect') void this.retryAfterRefresh();
  }

  private async onError(error: Error): Promise<void> {
    this.status.set(navigator.onLine ? 'connecting' : 'offline');
    const socket = this.socket;
    // Errors raised by the server's handshake do not make the client retry: do it here, slowly.
    if (!socket || socket.active) return;
    if (error.message === 'unauthorized') return void (await this.retryAfterRefresh());
    this.retryLater(error.message === 'too_many_connections' ? RETRY_MAX_MS : this.backoff());
  }

  private async retryAfterRefresh(): Promise<void> {
    if (!this.auth.getToken() && !(await this.auth.refresh())) return; // signed out: nothing to connect to
    if (this.auth.tokenExpiresAt() - Date.now() < 5_000) await this.auth.refresh();
    if (!this.auth.getToken()) return;
    this.retryLater(this.retries++ === 0 ? 0 : this.backoff());
  }

  private backoff(): number {
    const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.retries++);
    return base / 2 + Math.random() * (base / 2);
  }

  private retryLater(ms: number): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.socket && !this.socket.connected && this.auth.getToken()) this.socket.connect();
    }, ms);
  }

  /**
   * The network went away. The connection may look alive for another 45 s (until the next ping fails) while what the server
   * sends is lost, so it is not trusted again: coming back starts a new one, and the features catch up.
   */
  private networkLost(): void {
    if (!this.socket) return;
    this.suspect = true;
    this.status.set('offline');
  }

  private reconnectNow(): void {
    const socket = this.socket;
    if (!socket) return void (this.auth.getToken() && this.open());
    if (!socket.connected || this.suspect) {
      this.suspect = false;
      this.status.set('connecting');
      // The client library is in the middle of its backoff (up to 30 s between attempts): start over now.
      clearTimeout(this.retryTimer);
      socket.disconnect();
      socket.connect();
    }
  }

  private scheduleTokenRefresh(): void {
    clearTimeout(this.refreshTimer);
    const wait = Math.max(5_000, this.auth.tokenExpiresAt() - Date.now() - REFRESH_BEFORE_MS);
    this.refreshTimer = setTimeout(() => void this.auth.refresh(), wait);
  }

  private disconnect(): void {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.hiddenTimer);
    clearInterval(this.watchdog);
    this.socket?.disconnect();
    this.socket = null;
    this.joined.clear();
    this.denied.clear();
    this.suspended.clear();
    this.everConnected = false;
    this.retries = 0;
    this.status.set('offline');
  }

  // ---------------------------------------------------------------- rooms

  private enter(room: string): void {
    if (this.socket?.connected && !this.suspended.has(room)) void this.send(room);
  }

  private send(room: string): Promise<void> {
    return new Promise((resolve) => {
      const socket = this.socket;
      if (!socket?.connected) return resolve();
      socket
        .timeout(5000)
        .emit('room:join', parseRoom(room), (err: Error | null, ack?: { ok: boolean }) => {
          if (!err && ack?.ok) {
            this.joined.add(room);
            this.denied.delete(room);
          } else if (!err) this.denied.add(room);
          resolve();
        });
    });
  }

  private retryDenied(): void {
    for (const room of [...this.denied]) if (this.refs.has(room)) void this.send(room);
  }

  // ---------------------------------------------------------------- the page coming and going

  private onVisibility(): void {
    if (document.visibilityState === 'hidden') {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = setTimeout(() => {
        for (const room of this.refs.keys()) {
          if (!HEAVY.has(parseRoom(room).kind as RoomKind) || this.suspended.has(room)) continue;
          this.suspended.add(room);
          if (this.joined.delete(room)) this.socket?.emit('room:leave', parseRoom(room));
        }
      }, HIDDEN_LEAVE_MS);
      return;
    }
    clearTimeout(this.hiddenTimer);
    this.ping();
    if (this.socket && !this.socket.connected) return this.reconnectNow();
    if (!this.suspended.size) return;
    const back = [...this.suspended];
    this.suspended.clear();
    void Promise.all(
      back.filter((room) => this.refs.has(room)).map((room) => this.send(room)),
    ).then(() => this.resumed.next());
  }

  private ping(): void {
    const now = Date.now();
    if (
      !this.socket?.connected ||
      document.visibilityState !== 'visible' ||
      now - this.lastActivity < ACTIVITY_MS
    )
      return;
    this.lastActivity = now;
    this.socket.emit('presence:activity', this.focus ? { active: true, focus: this.focus } : { active: true });
  }

  private subject(event: string): Subject<unknown> {
    let subject = this.subjects.get(event);
    if (!subject) {
      subject = new Subject<unknown>();
      this.subjects.set(event, subject);
      const created = subject;
      this.socket?.on(event, (payload: unknown) => created.next(payload));
    }
    return subject;
  }
}

function parseRoom(room: string): { kind: string; id: string } {
  const i = room.indexOf(':');
  return { kind: room.slice(0, i), id: room.slice(i + 1) };
}
