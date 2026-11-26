import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { REALTIME_PATH } from '@os-planner/shared';
import type { TestApp } from './app.js';
import type { Account } from './helpers.js';

/** Starts the test app listening on a free port (the HTTP tests drive it without one) and returns its address. */
export async function listen(t: TestApp): Promise<string> {
  await t.app.listen(0, '127.0.0.1');
  const { port } = t.app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const open: Socket[] = [];

/** Closes every socket a test opened. Call from afterEach/afterAll. */
export function closeSockets(): void {
  for (const s of open.splice(0)) s.disconnect();
}

export interface ConnectOptions {
  /** Sent as the Origin header, like a browser does. */
  origin?: string;
  token?: string | null;
}

function client(url: string, token: string | null | undefined, opts: ConnectOptions): Socket {
  const socket = io(url, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: token === null ? {} : { token: token ?? undefined },
    ...(opts.origin ? { extraHeaders: { Origin: opts.origin } } : {}),
  });
  open.push(socket);
  return socket;
}

/** Connects with the account's access token and waits until the server accepts the connection. */
export function connect(
  url: string,
  who: Account | string | null,
  opts: ConnectOptions = {},
): Promise<Socket> {
  const token = who === null ? null : typeof who === 'string' ? who : who.token;
  const socket = client(url, opts.token === undefined ? token : opts.token, opts);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (e) => reject(e));
  });
}

/** The reason the server gave for refusing the connection (rejects if it was accepted). */
export function refused(
  url: string,
  who: Account | string | null,
  opts: ConnectOptions = {},
): Promise<string> {
  return connect(url, who, opts).then(
    () => Promise.reject(new Error('the connection was accepted')),
    (e: Error) => e.message,
  );
}

export const ack = <T = { ok: boolean }>(
  socket: Socket,
  event: string,
  payload?: unknown,
): Promise<T> =>
  new Promise(
    (resolve) =>
      void socket
        .timeout(3000)
        .emit(event, payload, (err: Error | null, res: T) =>
          resolve(err ? ({ ok: false, timeout: true } as T) : res),
        ),
  );

/** Records everything a socket receives under `event`. */
export function collect<T = unknown>(socket: Socket, event: string): T[] {
  const seen: T[] = [];
  socket.on(event, (payload: T) => seen.push(payload));
  return seen;
}

/** Resolves with the next `event`, or rejects after `ms`. */
export const next = <T = unknown>(socket: Socket, event: string, ms = 3000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "${event}" within ${ms} ms`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

/** Resolves when the server closes the connection (immediately if it already closed). */
export const closed = (socket: Socket, ms = 4000): Promise<string> =>
  new Promise((resolve, reject) => {
    if (socket.disconnected) return resolve('already');
    const timer = setTimeout(() => reject(new Error('the connection stayed open')), ms);
    socket.once('disconnect', (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
