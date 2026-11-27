import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createGunzip, createInflate } from 'node:zlib';
import { ICS_LIMITS, type IcsError } from '@os-planner/shared/ics';

/** Why a calendar address could not be read. The code is what the website shows (`ics.error.<code>`). */
export class IcsFetchError extends Error {
  constructor(readonly code: IcsError) {
    super(code);
  }
}

// ---------------------------------------------------------------- addresses that must never be reached

const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
] as const)
  blocked4.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback, and the old IPv4-compatible block
  ['::ffff:0:0', 96], // IPv4-mapped (also judged by the address inside, below)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const)
  blocked6.addSubnet(net, bits, 'ipv6');

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:7f00:1`), or null. */
function mappedV4(ip: string): string | null {
  let h: string;
  try {
    h = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase(); // the compressed form, with a dotted tail turned into hex
  } catch {
    return null;
  }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!m) return null;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for any address that is not an ordinary public one: private, loopback, link-local, metadata, multicast, reserved, and the IPv6 ways to wrap those. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0]!;
  const kind = isIP(bare);
  if (kind === 4) return blocked4.check(bare, 'ipv4');
  if (kind === 6) {
    const inner = mappedV4(bare);
    if (inner) return blocked4.check(inner, 'ipv4');
    return blocked6.check(bare, 'ipv6');
  }
  return true; // not an address at all
}

// ---------------------------------------------------------------- addresses of calendars

export interface ParsedCalendarUrl {
  /** The addresses to try, in order (`webcal:` is https first, then http when that is allowed). */
  candidates: URL[];
}

/** Reads what a person typed. Only http, https and webcal; no credentials in the address. */
export function parseCalendarUrl(input: string, allowHttp: boolean): ParsedCalendarUrl {
  const text = input.trim();
  if (!text || text.length > ICS_LIMITS.urlMax || /[\u0000-\u001f\u007f\s]/.test(text))
    throw new IcsFetchError('ics_bad_url');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new IcsFetchError('ics_bad_url');
  }
  if (url.username || url.password || !url.hostname) throw new IcsFetchError('ics_bad_url');
  const swap = (protocol: 'http:' | 'https:'): URL => {
    const u = new URL(url.href.replace(/^[a-z]+:/i, protocol));
    return u;
  };
  switch (url.protocol) {
    case 'https:':
      return { candidates: [url] };
    case 'http:':
      if (!allowHttp) throw new IcsFetchError('ics_bad_url');
      return { candidates: [url] };
    case 'webcal:':
    case 'webcals:':
      return {
        candidates:
          url.protocol === 'webcals:' || !allowHttp
            ? [swap('https:')]
            : [swap('https:'), swap('http:')],
      };
    default:
      throw new IcsFetchError('ics_bad_url');
  }
}

// ---------------------------------------------------------------- fetching

export interface TransportRequest {
  /** The checked address to connect to: the one that was looked up, never looked up again. */
  address: string;
  url: URL;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  /** Already decompressed and no larger than `maxBytes`. */
  body: Buffer;
}

export type Transport = (r: TransportRequest) => Promise<TransportResponse>;

/** Plain `http`/`https` request to a given address (the host name stays in the `Host` header and in TLS). */
export const nodeTransport: Transport = (r) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const secure = r.url.protocol === 'https:';
    const hostname = r.url.hostname.replace(/^\[|\]$/g, '');
    const options: https.RequestOptions = {
      host: r.address,
      port: r.url.port ? Number(r.url.port) : secure ? 443 : 80,
      path: r.url.pathname + r.url.search,
      method: 'GET',
      headers: { ...r.headers, Host: r.url.host },
      agent: false,
      ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
    };
    let done = false;
    const finish = (err: IcsFetchError | null, value?: TransportResponse): void => {
      if (done) return;
      done = true;
      r.signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value!);
    };
    const req = (secure ? https : http).request(options, (res) => {
      const status = res.statusCode ?? 0;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      const declared = Number(headers['content-length']);
      if (
        status === 200 &&
        Number.isFinite(declared) &&
        declared > r.maxBytes &&
        !headers['content-encoding']
      ) {
        req.destroy();
        return finish(new IcsFetchError('ics_too_large'));
      }
      const encoding = (headers['content-encoding'] ?? '').toLowerCase();
      const out =
        encoding === 'gzip' || encoding === 'x-gzip'
          ? res.pipe(createGunzip())
          : encoding === 'deflate'
            ? res.pipe(createInflate())
            : res;
      const chunks: Buffer[] = [];
      let size = 0;
      out.on('data', (c: Buffer) => {
        size += c.length;
        if (size > r.maxBytes) {
          req.destroy();
          finish(new IcsFetchError('ics_too_large'));
          return;
        }
        chunks.push(c);
      });
      out.on('end', () => finish(null, { status, headers, body: Buffer.concat(chunks) }));
      out.on('error', () => finish(new IcsFetchError('ics_unreachable')));
      res.on('error', () => finish(new IcsFetchError('ics_unreachable')));
    });
    const onAbort = (): void => {
      req.destroy();
      finish(new IcsFetchError('ics_timeout'));
    };
    if (r.signal.aborted) return onAbort();
    r.signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', () => finish(new IcsFetchError('ics_unreachable')));
    req.end();
  });

export interface SafeFetchOptions {
  allowHttp: boolean;
  /** Hosts (`host`, `host:port` or an address) that may be reached though they are private. */
  privateAllowlist?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  etag?: string | null;
  lastModified?: string | null;
  /** Looks a host name up. Called once per request, and the answer is what is connected to. Replaced in tests. */
  resolve?: (host: string) => Promise<string[]>;
  transport?: Transport;
}

export type SafeFetchResult =
  | { notModified: true }
  | {
      notModified: false;
      body: string;
      etag: string | null;
      lastModified: string | null;
      finalUrl: string;
    };

const defaultResolve = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const ACCEPTED_TYPES = new Set([
  'text/calendar',
  'text/plain',
  'application/ics',
  'application/x-ics',
]);

/** Is this host (with this port) one the operator allowed on a private network? */
function allowed(list: readonly string[], url: URL, address: string): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return list.some(
    (e) =>
      e === host ||
      e === `${host}:${port}` ||
      e === address.toLowerCase() ||
      e === `${address.toLowerCase()}:${port}`,
  );
}

/**
 * Reads a calendar from an address a person gave, without letting them reach anything private.
 * The name is looked up once; every address it gives must be public (or allowed by the operator), and the connection goes to that
 * same address, so the name cannot change its answer in between. Every redirect is checked in the same way (at most 3). The whole
 * thing has a time limit and a size limit (also after decompression), and only calendar content types are taken.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? ICS_LIMITS.maxBytes;
  const timeoutMs = options.timeoutMs ?? ICS_LIMITS.fetchTimeoutMs;
  const maxRedirects = options.maxRedirects ?? ICS_LIMITS.maxRedirects;
  const resolve = options.resolve ?? defaultResolve;
  const transport = options.transport ?? nodeTransport;
  const list = (options.privateAllowlist ?? []).map((e) => e.toLowerCase());
  const { candidates } = parseCalendarUrl(rawUrl, options.allowHttp);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let last: IcsFetchError | null = null;
    for (const start of candidates) {
      try {
        return await follow(start);
      } catch (e) {
        if (!(e instanceof IcsFetchError)) throw e;
        // Only "could not connect" moves on to the next address (webcal: https, then http).
        if (e.code !== 'ics_unreachable') throw e;
        last = e;
      }
    }
    throw last ?? new IcsFetchError('ics_unreachable');
  } finally {
    clearTimeout(timer);
  }

  async function follow(first: URL): Promise<SafeFetchResult> {
    let url = first;
    for (let hop = 0; ; hop++) {
      if (ctl.signal.aborted) throw new IcsFetchError('ics_timeout');
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowHttp))
        throw new IcsFetchError('ics_bad_url');
      if (url.username || url.password) throw new IcsFetchError('ics_bad_url');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let addresses: string[];
      if (isIP(host)) addresses = [host];
      else {
        try {
          addresses = await withAbort(resolve(host), ctl.signal);
        } catch (e) {
          if (e instanceof IcsFetchError) throw e;
          throw new IcsFetchError('ics_unreachable');
        }
      }
      if (!addresses.length) throw new IcsFetchError('ics_unreachable');
      // One private answer among public ones is enough to refuse: the next lookup could hand out that one.
      if (!allowed(list, url, addresses[0]!) && addresses.some(isBlockedAddress))
        throw new IcsFetchError('ics_blocked_address');

      const headers: Record<string, string> = {
        'User-Agent': 'OS_Planner-Calendar-Sync/1.0',
        Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1',
        'Accept-Encoding': 'gzip',
      };
      if (hop === 0 && options.etag) headers['If-None-Match'] = options.etag;
      if (hop === 0 && options.lastModified) headers['If-Modified-Since'] = options.lastModified;
      const res = await transport({
        address: addresses[0]!,
        url,
        headers,
        signal: ctl.signal,
        maxBytes,
      });

      if (res.status === 304) return { notModified: true };
      if (res.status >= 300 && res.status < 400 && res.headers['location']) {
        if (hop >= maxRedirects) throw new IcsFetchError('ics_too_many_redirects');
        try {
          url = new URL(res.headers['location'], url);
        } catch {
          throw new IcsFetchError('ics_bad_url');
        }
        continue;
      }
      if (res.status !== 200) throw new IcsFetchError('ics_http_error');
      const type = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (!ACCEPTED_TYPES.has(type)) throw new IcsFetchError('ics_not_a_calendar');
      return {
        notModified: false,
        body: res.body.toString('utf8').replace(/^\uFEFF/, ''),
        etag: res.headers['etag']?.slice(0, 255) ?? null,
        lastModified: res.headers['last-modified']?.slice(0, 64) ?? null,
        finalUrl: url.href,
      };
    }
  }
}

/** Gives up on a promise when the time is over (a name server that never answers). */
function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new IcsFetchError('ics_timeout'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
