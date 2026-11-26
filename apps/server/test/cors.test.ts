import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedOrigins, parseEnv } from '../src/config/env.js';
import { createTestApp, GOOD_PASSWORD, uniqueEmail, type TestApp } from './app.js';
import { png } from './fixtures.js';
import { signup, uuid } from './helpers.js';

const SITE = 'https://planner.example.com';
const OTHER = 'https://evil.example.org';
const CSRF = { 'X-Requested-With': 'os_planner' };

/** Puts process.env back the way it was (assigning a whole new object to process.env would detach it from the real environment). */
function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
}

const baseEnv = {
  APP_URL: 'http://localhost:4200',
  DATABASE_URL: 'mysql://notes:notes@localhost:3306/notes',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  JWT_MEDIA_SECRET: 'y'.repeat(40),
};

describe('CORS / cookie settings in the environment', () => {
  it('defaults to same-origin: only APP_URL is allowed and the cookie is strict', () => {
    const env = parseEnv(baseEnv);
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.COOKIE_SAMESITE).toBe('strict');
    expect(env.OS_PLANNER_API_URL).toBeUndefined();
    expect(allowedOrigins(env)).toEqual(['http://localhost:4200']);
  });

  it('reads a comma-separated list and normalises each entry to an origin', () => {
    const env = parseEnv({ ...baseEnv, CORS_ORIGINS: ` ${SITE}/ , http://localhost:4300/some/path,${SITE}` });
    expect(env.CORS_ORIGINS).toEqual([SITE, 'http://localhost:4300']);
    expect(allowedOrigins(env)).toEqual(['http://localhost:4200', SITE, 'http://localhost:4300']);
  });

  it('rejects wildcards and non-http(s) entries', () => {
    expect(() => parseEnv({ ...baseEnv, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    expect(() => parseEnv({ ...baseEnv, CORS_ORIGINS: `${SITE},ftp://files.example.com` })).toThrow(/CORS_ORIGINS/);
  });

  it('refuses SameSite=None on a site that is not https, accepts it on https', () => {
    expect(() => parseEnv({ ...baseEnv, COOKIE_SAMESITE: 'none' })).toThrow(/COOKIE_SAMESITE/);
    expect(parseEnv({ ...baseEnv, APP_URL: SITE, COOKIE_SAMESITE: 'none' }).COOKIE_SAMESITE).toBe('none');
    expect(() => parseEnv({ ...baseEnv, COOKIE_SAMESITE: 'sometimes' })).toThrow(/COOKIE_SAMESITE/);
  });

  it('takes the API address as one origin', () => {
    expect(parseEnv({ ...baseEnv, OS_PLANNER_API_URL: 'https://api.example.com/' }).OS_PLANNER_API_URL).toBe('https://api.example.com');
    expect(parseEnv({ ...baseEnv, OS_PLANNER_API_URL: '' }).OS_PLANNER_API_URL).toBeUndefined();
    expect(() => parseEnv({ ...baseEnv, OS_PLANNER_API_URL: 'a.example.com, b.example.com' })).toThrow(/OS_PLANNER_API_URL/);
  });
});

describe('an API used from another website', () => {
  let t: TestApp;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.APP_URL = SITE;
    process.env.CORS_ORIGINS = 'https://app.example.net';
    process.env.COOKIE_SAMESITE = 'none';
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
    restoreEnv(saved);
  });

  it('answers the preflight for an allowed website, with credentials and the headers the app sends', async () => {
    const res = await t.http
      .options('/api/auth/refresh')
      .set('Origin', 'https://app.example.net')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-requested-with,content-type,authorization');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.net');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']?.toLowerCase()).toEqual(expect.stringContaining('x-requested-with'));
    expect(res.headers['access-control-allow-headers']?.toLowerCase()).toEqual(expect.stringContaining('authorization'));
  });

  it('also allows APP_URL itself, and nothing else', async () => {
    const own = await t.http.get('/api/health').set('Origin', SITE);
    expect(own.headers['access-control-allow-origin']).toBe(SITE);
    const stranger = await t.http.get('/api/health').set('Origin', OTHER);
    expect(stranger.status).toBe(200);
    expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await t.http.options('/api/auth/refresh').set('Origin', OTHER).set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard, and exposes Content-Disposition for downloads', async () => {
    const res = await t.http.get('/api/health').set('Origin', 'https://app.example.net');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    expect(res.headers['access-control-expose-headers']).toContain('Content-Disposition');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('sets the refresh cookie as Secure; SameSite=None so it travels cross-site, and clears it the same way', async () => {
    const email = uniqueEmail('cors');
    const res = await t.http.post('/api/auth/register').set('Origin', 'https://app.example.net').send({ email, password: GOOD_PASSWORD, displayName: 'Cors' });
    expect(res.status).toBe(201);
    const cookie = String(([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]);
    expect(cookie).toMatch(/SameSite=None/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);

    const out = await t.http.post('/api/auth/logout').set(CSRF).set('Cookie', cookie.split(';')[0]!);
    const cleared = String(([] as string[]).concat(out.headers['set-cookie'] ?? [])[0]);
    expect(cleared).toMatch(/SameSite=None/i);
    expect(cleared).toMatch(/Secure/i);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('lets the trusted websites embed media (judged by Referer or Origin), and only media', async () => {
    const me = await signup(t);
    const id = uuid();
    const up = await t.http.post('/api/media').set(me.auth).field('id', id).attach('file', await png(), 'a.png');
    expect(up.status).toBe(201);
    const token = (await t.http.post('/api/auth/media-token').set(me.auth)).body.token as string;
    const get = () => t.http.get(`/api/media/${id}`).query({ t: token });

    const fromCors = await get().set('Referer', 'https://app.example.net/app/p/1');
    expect(fromCors.status).toBe(200);
    expect(fromCors.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(fromCors.headers['vary']).toContain('Referer');
    expect((await get().set('Referer', `${SITE}/x`)).headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect((await get().set('Origin', 'https://app.example.net')).headers['cross-origin-resource-policy']).toBe('cross-origin');

    // strangers, and requests that say nothing about where they come from, stay same-origin only
    expect((await get().set('Referer', `${OTHER}/page`)).headers['cross-origin-resource-policy']).toBe('same-origin');
    expect((await get()).headers['cross-origin-resource-policy']).toBe('same-origin');
    expect((await get().set('Referer', 'not a url')).headers['cross-origin-resource-policy']).toBe('same-origin');

    // everything else is never marked embeddable
    const json = await t.http.get('/api/health').set('Referer', 'https://app.example.net/');
    expect(json.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});

describe('a same-origin deployment (the default)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('keeps the strict cookie and does not open media to other origins', async () => {
    const res = await t.http.post('/api/auth/register').send({ email: uniqueEmail('same'), password: GOOD_PASSWORD, displayName: 'Same' });
    const cookie = String(([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]);
    expect(cookie).toMatch(/SameSite=Strict/i);

    const me = await signup(t);
    const id = uuid();
    await t.http.post('/api/media').set(me.auth).field('id', id).attach('file', await png(), 'a.png');
    const token = (await t.http.post('/api/auth/media-token').set(me.auth)).body.token as string;
    const media = (referer?: string) => {
      const req = t.http.get(`/api/media/${id}`).query({ t: token });
      return referer ? req.set('Referer', referer) : req;
    };
    expect((await media(OTHER)).headers['cross-origin-resource-policy']).toBe('same-origin');
    expect((await media()).headers['cross-origin-resource-policy']).toBe('same-origin');
    expect((await media('http://localhost:4200/app')).headers['cross-origin-resource-policy']).toBe('cross-origin'); // APP_URL itself
  });

  it('does not grant a foreign website access', async () => {
    const res = await t.http.get('/api/health').set('Origin', OTHER);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the API address shown to the browser', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'os-planner-cfg-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), '<!doctype html><app-root></app-root>');
    await writeFile(join(dir, 'config.json'), JSON.stringify({ apiUrl: 'https://api.example.com/' }));
    process.env.WEB_DIST_DIR = dir;
    process.env.APP_URL = SITE;
  });
  afterAll(async () => {
    restoreEnv(saved);
    await rm(dir, { recursive: true, force: true });
  });

  it('is added to the CSP of the website the server hosts, taken from the build config.json', async () => {
    const t = await createTestApp();
    try {
      const res = await t.http.get('/');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toMatch(/connect-src 'self' https:\/\/api\.example\.com/);
      expect(csp).toMatch(/img-src [^;]*https:\/\/api\.example\.com/);
      expect(csp).toMatch(/media-src [^;]*https:\/\/api\.example\.com/);
      const config = await t.http.get('/config.json');
      expect(config.status).toBe(200);
      expect(config.headers['cache-control']).toBe('no-cache'); // an edited config.json must apply at once
    } finally {
      await t.close();
    }
  });

  it('is left out of the CSP when the API shares the origin', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ apiUrl: '' }));
    const t = await createTestApp();
    try {
      const csp = String((await t.http.get('/')).headers['content-security-policy']);
      expect(csp).toMatch(/connect-src 'self';/);
      expect(csp).not.toContain('api.example.com');
    } finally {
      await t.close();
    }
  });
});
