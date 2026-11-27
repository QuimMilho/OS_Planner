import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scrub } from '../src/common/scrub.js';
import { isPlaceholder, parseEnv } from '../src/config/env.js';
import { routeOf } from '../src/ops/http-stats.js';
import { createTestApp, type TestApp } from './app.js';
import { signup, type Account } from './helpers.js';

const ADMIN_EMAIL = `ops-admin${Date.now()}@example.com`;
const METRICS_TOKEN = 'a-metrics-token-for-the-scraper-0123456789';
let t: TestApp;
let admin: Account;
let person: Account;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [k, v] of Object.entries({ ADMIN_EMAILS: ADMIN_EMAIL, METRICS_TOKEN })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t = await createTestApp();
  await t.prisma.team.deleteMany();
  await t.prisma.user.deleteMany();
  admin = await signup(t, true, ADMIN_EMAIL);
  person = await signup(t);
});
afterAll(async () => {
  await t.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('health', () => {
  it('reports each part, without login, and 200 while the database and the storage answer', async () => {
    const res = await t.http.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      db: 'ok',
      storage: 'ok',
      realtime: expect.stringMatching(/ok|degraded|down/),
      mail: expect.stringMatching(/ok|degraded/),
    });
    expect(Object.keys(res.body).sort()).toEqual(['db', 'mail', 'ok', 'realtime', 'storage']); // no Redis or voice configured here
    // the HEALTHCHECK of the image asks the strict question: the realtime server must be up as well
    const strict = await t.http.get('/api/health?strict=1');
    expect([200, 503]).toContain(strict.status);
  });
});

describe('metrics', () => {
  it('is only for instance administrators and the scraper token; everybody else gets 404', async () => {
    expect((await t.http.get('/api/metrics')).status).toBe(404);
    expect((await t.http.get('/api/metrics').set(person.auth)).status).toBe(404);
    expect(
      (
        await t.http
          .get('/api/metrics')
          .set('Authorization', 'Bearer not-the-token-at-all-but-long-enough')
      ).status,
    ).toBe(404);
    const res = await t.http.get('/api/metrics').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    for (const name of [
      'process_resident_memory_bytes',
      'nodejs_heap_size_used_bytes',
      'nodejs_active_resources',
      'os_planner_http_requests_total',
      'os_planner_http_request_duration_seconds_bucket',
      'os_planner_realtime_sockets',
      'os_planner_collab_documents',
      'os_planner_queue_email_digest_pending',
    ])
      expect(res.text).toContain(name);
    // what was asked before is counted, by route with the ids taken out
    expect(res.text).toMatch(
      /os_planner_http_requests_total\{method="GET",route="\/api\/health",status="2xx"\} \d+/,
    );
    expect(
      (await t.http.get('/api/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`)).status,
    ).toBe(200);
  });
});

describe('request ids', () => {
  it("every answer carries one: the caller's when it is a plain token, a new one otherwise", async () => {
    const mine = await t.http.get('/api/health').set('X-Request-Id', 'trace-1234.abc');
    expect(mine.headers['x-request-id']).toBe('trace-1234.abc');
    const odd = await t.http.get('/api/health').set('X-Request-Id', 'no spaces <allowed>');
    expect(odd.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const none = await t.http.get('/api/health');
    expect(none.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('log scrubbing', () => {
  it('takes tokens, secret addresses and query strings out of what is logged', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(scrub(`token ${jwt} here`)).toBe('token [jwt] here');
    expect(scrub('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [redacted]');
    expect(scrub('GET /api/feeds/3q2-u7Kd9Q1xYzz0aBcDeFgHiJkLmNoPq.ics')).toBe(
      'GET /api/feeds/[secret].ics',
    );
    expect(scrub('/api/links/abcdefghijklmnopqrstuvwxyz012345/pages/x')).toBe(
      '/api/links/[secret]/pages/x',
    );
    expect(scrub('https://planner.example.com/invite/AbCdEfGhIjKlMnOpQrStUv')).toBe(
      'https://planner.example.com/invite/[secret]',
    );
    expect(scrub('fetched https://calendar.example.com/x.ics?key=s3cret&u=1 ok')).toBe(
      'fetched https://calendar.example.com/x.ics?[redacted] ok',
    );
    expect(scrub('/api/media/1234?t=abc')).toBe('/api/media/1234?[redacted]');
    expect(scrub('push to https://fcm.googleapis.com/fcm/send/dEvIcE:APA91b failed')).toBe(
      'push to https://fcm.googleapis.com/[device] failed',
    );
    expect(scrub('{"password":"hunter22"}')).toBe('{"password":"[redacted]"}');
    expect(scrub('OS_Planner API listening on http://localhost:3000')).toBe(
      'OS_Planner API listening on http://localhost:3000',
    );
  });

  it('counts requests by route, not by id', () => {
    expect(routeOf('/api/teams/7f1c2d3e-0000-4000-8000-000000000001/members?x=1')).toBe(
      '/api/teams/:id/members',
    );
    expect(routeOf('/api/feeds/abcdefghijklmnopqrstu.ics')).toBe('/api/feeds/:secret');
  });
});

describe('secrets at start-up', () => {
  const base = {
    APP_URL: 'https://planner.example.com',
    DATABASE_URL: 'mysql://planner:a-real-database-password@db:3306/planner',
    JWT_ACCESS_SECRET: 'Wq4u9yY1vT6r0eQ8nM2kL5jH3gF7dS1aZ9xC4vB6nM8',
    JWT_MEDIA_SECRET: 'Pp0o9i8u7y6t5r4e3w2q1aZsXdCfVgBhNjMkL0p9o8',
  };
  it('refuses the placeholders of .env.example and default passwords in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'change-me-access-secret-change-me-access',
      }),
    ).toThrow(/JWT_ACCESS_SECRET is still a placeholder/);
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        RELEASE_TOKEN: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      }),
    ).toThrow(/RELEASE_TOKEN/);
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        DATABASE_URL: 'mysql://notes:notes@mysql:3306/notes',
      }),
    ).toThrow(/database password is a default/);
    expect(() =>
      parseEnv({ ...base, NODE_ENV: 'production', JWT_MEDIA_SECRET: base.JWT_ACCESS_SECRET }),
    ).toThrow(/must differ/);
    // outside production the development defaults keep working
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'development',
        DATABASE_URL: 'mysql://notes:notes@localhost:3306/notes',
        JWT_ACCESS_SECRET: 'change-me-access-secret-change-me-access',
      }),
    ).not.toThrow();
  });

  it('knows a placeholder when it sees one', () => {
    for (const v of [
      'change-me-media-secret-change-me-media-',
      'CHANGEME',
      'replace_me_please',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'secret',
    ])
      expect(isPlaceholder(v), v).toBe(true);
    for (const v of [base.JWT_ACCESS_SECRET, 'k3y-from-openssl-rand-base64-48-characters'])
      expect(isPlaceholder(v), v).toBe(false);
  });
});
