import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedBase, icsAllowHttp, parseEnv } from '../src/config/env.js';
import {
  IcsFetchError,
  isBlockedAddress,
  parseCalendarUrl,
  safeFetch,
  type SafeFetchOptions,
  type Transport,
  type TransportRequest,
} from '../src/ics/safe-fetch.js';

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const PUBLIC = '93.184.216.34';

/** Runs a fetch and returns the error code it was refused with (or 'ok'). */
async function outcome(
  url: string,
  o: Partial<SafeFetchOptions> & { allowHttp?: boolean } = {},
): Promise<string> {
  try {
    await safeFetch(url, { allowHttp: true, ...o });
    return 'ok';
  } catch (e) {
    if (e instanceof IcsFetchError) return e.code;
    throw e;
  }
}

/** A transport that records what it was asked and answers from a script; nothing leaves the process. */
function fake(
  answer: (
    r: TransportRequest,
    n: number,
  ) => { status: number; headers?: Record<string, string>; body?: string },
): {
  transport: Transport;
  calls: TransportRequest[];
} {
  const calls: TransportRequest[] = [];
  return {
    calls,
    transport: async (r) => {
      calls.push(r);
      const a = answer(r, calls.length);
      return {
        status: a.status,
        headers: { 'content-type': 'text/calendar', ...(a.headers ?? {}) },
        body: Buffer.from(a.body ?? ICS),
      };
    },
  };
}

describe('addresses that are refused', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.0.9',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.2.5',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fec0::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:c0a8:101',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    '[::1]',
    'not an address',
  ])('refuses %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    PUBLIC,
    '172.32.0.1',
    '100.63.255.255',
    '192.169.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4009::200e',
    '::ffff:8.8.8.8',
  ])('accepts %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('what a person may type', () => {
  it('takes http, https and webcal and nothing else', () => {
    expect(parseCalendarUrl('https://example.com/a.ics', false).candidates.map(String)).toEqual([
      'https://example.com/a.ics',
    ]);
    expect(parseCalendarUrl('webcal://example.com/a.ics', true).candidates.map(String)).toEqual([
      'https://example.com/a.ics',
      'http://example.com/a.ics',
    ]);
    expect(parseCalendarUrl('webcal://example.com/a.ics', false).candidates.map(String)).toEqual([
      'https://example.com/a.ics',
    ]);
    for (const bad of [
      'file:///etc/passwd',
      'gopher://example.com/',
      'ftp://example.com/a.ics',
      'javascript:alert(1)',
      'data:text/calendar,BEGIN:VCALENDAR',
      'https://user:pass@example.com/a.ics',
      'https://example.com/a b.ics',
      '',
      'example.com/a.ics',
      `https://example.com/${'a'.repeat(2100)}`,
    ])
      expect(() => parseCalendarUrl(bad, true), bad).toThrowError(IcsFetchError);
    expect(() => parseCalendarUrl('http://example.com/a.ics', false)).toThrowError(/ics_bad_url/);
  });
});

describe('refusing before anything is sent', () => {
  const cases: [string, string, string[] | undefined][] = [
    ['a name that points at loopback', 'https://localhost.test/a.ics', ['127.0.0.1']],
    ['the metadata address by name', 'https://meta.test/a.ics', ['169.254.169.254']],
    ['a private range by name', 'https://lan.test/a.ics', ['10.1.2.3']],
    ['an IPv6 loopback by name', 'https://v6.test/a.ics', ['::1']],
    ['an IPv4-mapped IPv6 address by name', 'https://mapped.test/a.ics', ['::ffff:127.0.0.1']],
    ['public and private answers together', 'https://mixed.test/a.ics', [PUBLIC, '192.168.0.9']],
    ['the metadata address as a literal', 'http://169.254.169.254/latest/meta-data/', undefined],
    ['loopback as a literal', 'http://127.0.0.1:8080/a.ics', undefined],
    ['IPv6 loopback as a literal', 'http://[::1]/a.ics', undefined],
    ['loopback written as one number', 'http://2130706433/a.ics', undefined],
    ['loopback written in hex', 'http://0x7f.0.0.1/a.ics', undefined],
    ['an IPv4-mapped literal', 'http://[::ffff:7f00:1]/a.ics', undefined],
  ];
  it.each(cases)('%s', async (_name, url, answer) => {
    const { transport, calls } = fake(() => ({ status: 200 }));
    let lookups = 0;
    const code = await outcome(url, {
      transport,
      resolve: async () => {
        lookups++;
        return answer ?? [];
      },
    });
    expect(code).toBe('ics_blocked_address');
    expect(calls).toHaveLength(0);
    expect(lookups).toBe(answer ? 1 : 0);
  });

  it('refuses other schemes without looking anything up', async () => {
    const { transport, calls } = fake(() => ({ status: 200 }));
    let lookups = 0;
    const resolve = async () => (lookups++, [PUBLIC]);
    for (const url of [
      'file:///etc/passwd',
      'gopher://example.com/',
      'ftp://example.com/a.ics',
      'https://u:p@example.com/a.ics',
    ])
      expect(await outcome(url, { transport, resolve }), url).toBe('ics_bad_url');
    expect(
      await outcome('http://example.com/a.ics', { transport, resolve, allowHttp: false }),
    ).toBe('ics_bad_url');
    expect(calls).toHaveLength(0);
    expect(lookups).toBe(0);
  });

  it('lets the operator allow a private host, and only that one', async () => {
    const { transport, calls } = fake(() => ({ status: 200 }));
    const resolve = async () => ['10.0.0.5'];
    expect(await outcome('https://cal.corp.test/a.ics', { transport, resolve })).toBe(
      'ics_blocked_address',
    );
    expect(
      await outcome('https://cal.corp.test/a.ics', {
        transport,
        resolve,
        privateAllowlist: ['cal.corp.test'],
      }),
    ).toBe('ok');
    // A host alone is allowed on any port; with a port, only that one.
    expect(
      await outcome('https://cal.corp.test:8443/a.ics', {
        transport,
        resolve,
        privateAllowlist: ['cal.corp.test'],
      }),
    ).toBe('ok');
    expect(
      await outcome('https://cal.corp.test:8443/a.ics', {
        transport,
        resolve,
        privateAllowlist: ['cal.corp.test:8443'],
      }),
    ).toBe('ok');
    expect(
      await outcome('https://cal.corp.test/a.ics', {
        transport,
        resolve,
        privateAllowlist: ['cal.corp.test:8443'],
      }),
    ).toBe('ics_blocked_address');
    expect(
      await outcome('https://other.test/a.ics', {
        transport,
        resolve,
        privateAllowlist: ['cal.corp.test'],
      }),
    ).toBe('ics_blocked_address');
    expect(calls).toHaveLength(3);
  });
});

describe('names that change their answer', () => {
  it('looks a name up once and connects to the address it checked', async () => {
    const answers = [[PUBLIC], ['127.0.0.1']];
    let lookups = 0;
    const { transport, calls } = fake(() => ({ status: 200 }));
    const resolve = async () => answers[Math.min(lookups++, 1)]!;
    expect(await outcome('https://rebind.test/a.ics', { transport, resolve })).toBe('ok');
    expect(lookups).toBe(1);
    expect(calls.map((c) => c.address)).toEqual([PUBLIC]);
    // The next request gets the second answer and is refused.
    expect(await outcome('https://rebind.test/a.ics', { transport, resolve })).toBe(
      'ics_blocked_address',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('redirects', () => {
  const resolve = async (host: string) => (host === 'internal.test' ? ['10.0.0.9'] : [PUBLIC]);

  it('checks every hop', async () => {
    for (const target of [
      'http://169.254.169.254/latest/',
      'http://127.0.0.1:9/a.ics',
      'http://[::1]/a.ics',
      'http://internal.test/a.ics',
      'https://internal.test/a.ics',
    ]) {
      const { transport, calls } = fake((r) =>
        r.url.hostname === 'start.test'
          ? { status: 302, headers: { location: target } }
          : { status: 200 },
      );
      expect(await outcome('https://start.test/a.ics', { transport, resolve }), target).toBe(
        'ics_blocked_address',
      );
      expect(calls.map((c) => c.url.hostname)).toEqual(['start.test']); // nothing was sent to the internal target
    }
  });

  it('refuses a redirect to another scheme', async () => {
    for (const target of ['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/x']) {
      const { transport, calls } = fake(() => ({ status: 301, headers: { location: target } }));
      expect(await outcome('https://start.test/a.ics', { transport, resolve }), target).toBe(
        'ics_bad_url',
      );
      expect(calls).toHaveLength(1);
    }
  });

  it('follows up to three and then stops', async () => {
    const three = fake((_r, n) =>
      n <= 3 ? { status: 302, headers: { location: `/hop${n}` } } : { status: 200 },
    );
    expect(await outcome('https://start.test/a.ics', { transport: three.transport, resolve })).toBe(
      'ok',
    );
    expect(three.calls).toHaveLength(4);
    const endless = fake(() => ({ status: 302, headers: { location: '/again' } }));
    expect(
      await outcome('https://start.test/a.ics', { transport: endless.transport, resolve }),
    ).toBe('ics_too_many_redirects');
    expect(endless.calls).toHaveLength(4);
  });

  it('sends the conditional headers only to the address that was asked', async () => {
    const { transport, calls } = fake((_r, n) =>
      n === 1
        ? { status: 302, headers: { location: 'https://elsewhere.test/b.ics' } }
        : { status: 200 },
    );
    await outcome('https://start.test/a.ics', { transport, resolve, etag: '"v1"' });
    expect(calls[0]!.headers['If-None-Match']).toBe('"v1"');
    expect(calls[1]!.headers['If-None-Match']).toBeUndefined();
  });
});

describe('what comes back', () => {
  it('answers "not modified" and reads the validators', async () => {
    const { transport } = fake((r) =>
      r.headers['If-None-Match'] === '"v1"'
        ? { status: 304 }
        : {
            status: 200,
            headers: { etag: '"v2"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' },
          },
    );
    const resolve = async () => [PUBLIC];
    expect(
      await safeFetch('https://x.test/a.ics', {
        allowHttp: false,
        transport,
        resolve,
        etag: '"v1"',
      }),
    ).toEqual({ notModified: true });
    expect(
      await safeFetch('https://x.test/a.ics', { allowHttp: false, transport, resolve }),
    ).toMatchObject({
      notModified: false,
      etag: '"v2"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
      body: ICS,
    });
  });

  it('refuses other content types and other statuses', async () => {
    const resolve = async () => [PUBLIC];
    const html = fake(() => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    expect(await outcome('https://x.test/a', { transport: html.transport, resolve })).toBe(
      'ics_not_a_calendar',
    );
    const json = fake(() => ({ status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await outcome('https://x.test/a', { transport: json.transport, resolve })).toBe(
      'ics_not_a_calendar',
    );
    const missing = fake(() => ({ status: 404 }));
    expect(await outcome('https://x.test/a', { transport: missing.transport, resolve })).toBe(
      'ics_http_error',
    );
    const plain = fake(() => ({ status: 200, headers: { 'content-type': 'text/plain' } }));
    expect(await outcome('https://x.test/a', { transport: plain.transport, resolve })).toBe('ok');
  });

  it('tries https and then http for webcal:, and only moves on when it could not connect', async () => {
    const resolve = async () => [PUBLIC];
    const calls: string[] = [];
    const transport: Transport = async (r) => {
      calls.push(r.url.protocol);
      if (r.url.protocol === 'https:') throw new IcsFetchError('ics_unreachable');
      return { status: 200, headers: { 'content-type': 'text/calendar' }, body: Buffer.from(ICS) };
    };
    expect(await outcome('webcal://x.test/a.ics', { transport, resolve })).toBe('ok');
    expect(calls).toEqual(['https:', 'http:']);
    calls.length = 0;
    expect(await outcome('webcal://x.test/a.ics', { transport, resolve, allowHttp: false })).toBe(
      'ics_unreachable',
    );
    expect(calls).toEqual(['https:']);
  });
});

// ------------------------------------------------------------------ the real transport, against a local server

describe('the real connection', () => {
  let server: Server;
  let port: number;
  let hits: string[] = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_q, res) => res.end();

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const base = () => `http://127.0.0.1:${port}`;
  const allow = () => ({ privateAllowlist: [`127.0.0.1:${port}`] });
  const calendar = (
    res: ServerResponse,
    body: string | Buffer,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', ...headers });
    res.end(body);
  };

  it('does not reach a private server unless the operator allowed it', async () => {
    hits = [];
    handler = (_q, res) => calendar(res, ICS);
    expect(await outcome(`${base()}/a.ics`)).toBe('ics_blocked_address');
    expect(hits).toEqual([]); // nothing arrived at the internal server
    expect(await outcome(`${base()}/a.ics`, allow())).toBe('ok');
    expect(hits).toEqual(['/a.ics']);
  });

  it('reads a calendar, plain and gzipped, and sends conditional headers', async () => {
    let seen: IncomingMessage['headers'] = {};
    handler = (req, res) => {
      seen = req.headers;
      if (req.headers['if-none-match'] === '"abc"') {
        res.writeHead(304);
        return void res.end();
      }
      if (req.url === '/gz.ics')
        return calendar(res, gzipSync(ICS), { 'content-encoding': 'gzip', etag: '"abc"' });
      calendar(res, ICS, { etag: '"abc"' });
    };
    expect(await safeFetch(`${base()}/a.ics`, { allowHttp: true, ...allow() })).toMatchObject({
      notModified: false,
      body: ICS,
      etag: '"abc"',
    });
    expect(seen['user-agent']).toMatch(/OS_Planner/);
    expect(seen['accept-encoding']).toBe('gzip');
    expect(await safeFetch(`${base()}/gz.ics`, { allowHttp: true, ...allow() })).toMatchObject({
      body: ICS,
    });
    expect(
      await safeFetch(`${base()}/a.ics`, { allowHttp: true, ...allow(), etag: '"abc"' }),
    ).toEqual({ notModified: true });
  });

  it('refuses a body that is too large, however it is sent', async () => {
    const big = 'X'.repeat(50_000);
    handler = (req, res) => {
      if (req.url === '/declared.ics') return calendar(res, big.repeat(4)); // Content-Length says so up front
      if (req.url === '/chunked.ics') {
        res.writeHead(200, { 'content-type': 'text/calendar' });
        for (let i = 0; i < 20; i++) res.write(big);
        return void res.end();
      }
      if (req.url === '/bomb.ics')
        return calendar(res, gzipSync(Buffer.alloc(5_000_000, 65)), { 'content-encoding': 'gzip' });
      calendar(res, ICS);
    };
    for (const path of ['/declared.ics', '/chunked.ics', '/bomb.ics'])
      expect(await outcome(`${base()}${path}`, { ...allow(), maxBytes: 100_000 }), path).toBe(
        'ics_too_large',
      );
    expect(await outcome(`${base()}/ok.ics`, { ...allow(), maxBytes: 100_000 })).toBe('ok');
  });

  it('gives up on a server that is too slow, however it is slow', async () => {
    handler = (req, res) => {
      if (req.url === '/silent.ics') return; // never answers
      res.writeHead(200, { 'content-type': 'text/calendar' }); // answers, then drips
      const t = setInterval(() => res.write('X'), 50);
      res.on('close', () => clearInterval(t));
    };
    const t0 = Date.now();
    expect(await outcome(`${base()}/silent.ics`, { ...allow(), timeoutMs: 300 })).toBe(
      'ics_timeout',
    );
    expect(await outcome(`${base()}/drip.ics`, { ...allow(), timeoutMs: 300 })).toBe('ics_timeout');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('follows a redirect on the same server only when that server is allowed', async () => {
    handler = (req, res) => {
      if (req.url === '/go') {
        res.writeHead(302, { location: '/there.ics' });
        return void res.end();
      }
      calendar(res, ICS);
    };
    expect(await outcome(`${base()}/go`, allow())).toBe('ok');
  });

  it('reports a closed port as unreachable', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    expect(
      await outcome(`http://127.0.0.1:${closed}/a.ics`, {
        privateAllowlist: [`127.0.0.1:${closed}`],
      }),
    ).toBe('ics_unreachable');
  });
});

describe('settings', () => {
  // production refuses the development database password (phase 17): give the configuration a real-looking one
  const base = () => ({ ...process.env, DATABASE_URL: 'mysql://planner:a-real-password-here@localhost:3306/planner' });

  it('reads an empty ICS_ALLOW_HTTP (what docker compose passes when it is unset) as "not set"', () => {
    const env = parseEnv({ ...base(), ICS_ALLOW_HTTP: '', NODE_ENV: 'development' });
    expect(env.ICS_ALLOW_HTTP).toBeUndefined();
    expect(icsAllowHttp(env)).toBe(true);
    expect(icsAllowHttp(parseEnv({ ...base(), ICS_ALLOW_HTTP: '', NODE_ENV: 'production' }))).toBe(
      false,
    );
  });

  it('lets the operator decide', () => {
    expect(
      icsAllowHttp(parseEnv({ ...base(), ICS_ALLOW_HTTP: 'true', NODE_ENV: 'production' })),
    ).toBe(true);
    expect(
      icsAllowHttp(parseEnv({ ...base(), ICS_ALLOW_HTTP: 'false', NODE_ENV: 'development' })),
    ).toBe(false);
    expect(() => parseEnv({ ...base(), ICS_ALLOW_HTTP: 'maybe' })).toThrowError(/ICS_ALLOW_HTTP/);
  });

  it('reads the allowlist and the storage cap', () => {
    const env = parseEnv({
      ...base(),
      ICS_PRIVATE_ALLOWLIST: ' Cal.Corp.Test , 10.0.0.5:8080,,cal.corp.test',
    });
    expect(env.ICS_PRIVATE_ALLOWLIST).toEqual(['cal.corp.test', '10.0.0.5:8080']);
    expect(parseEnv({ ...base(), EXTERNAL_CALENDAR_MAX_MB: '12' }).EXTERNAL_CALENDAR_MAX_MB).toBe(
      12,
    );
  });

  it('gives the address calendar apps use: the API origin, else the site', () => {
    expect(
      feedBase(
        parseEnv({ ...base(), APP_URL: 'https://planner.example.com/', OS_PLANNER_API_URL: '' }),
      ),
    ).toBe('https://planner.example.com');
    expect(
      feedBase(
        parseEnv({
          ...base(),
          APP_URL: 'https://planner.example.com',
          OS_PLANNER_API_URL: 'https://api.example.com',
        }),
      ),
    ).toBe('https://api.example.com');
  });
});
