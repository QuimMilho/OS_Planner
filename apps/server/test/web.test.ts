import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';

let t: TestApp;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'os-planner-web-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>OS_Planner</title><app-root></app-root>');
  await writeFile(join(dir, 'ngsw.json'), '{"configVersion":1}');
  await writeFile(join(dir, 'main-ABCD1234.js'), 'console.log("app")');
  await writeFile(join(dir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  process.env.WEB_DIST_DIR = dir;
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  delete process.env.WEB_DIST_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('serving the Angular build from the API origin', () => {
  it('serves index.html at / and revalidates it on every load', async () => {
    const res = await t.http.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<app-root>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it.each(['/login', '/app/p/0192f0a4-7c1e-7b3a-9d2e-3f4a5b6c7d8e', '/verify-email', '/download'])(
    'gives deep link %s the app shell so client-side routing can take over',
    async (path) => {
      const res = await t.http.get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<app-root>');
    },
  );

  it('never lets the service-worker manifest be cached', async () => {
    const res = await t.http.get('/ngsw.json');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('caches hashed bundles forever', async () => {
    const res = await t.http.get('/main-ABCD1234.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('keeps a missing asset a real 404 instead of masking it with index.html', async () => {
    const res = await t.http.get('/chunk-MISSING.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<app-root>');
  });

  it('leaves the API alone: unknown API routes are JSON 404s, not the app shell', async () => {
    const res = await t.http.get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<app-root>');
    expect((await t.http.get('/api/me')).status).toBe(401);
  });

  it('sends security headers with the app shell', async () => {
    const res = await t.http.get('/');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
