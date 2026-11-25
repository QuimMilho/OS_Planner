import { createHash, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StorageService } from '../src/media/storage.service.js';
import { createTestApp, type TestApp } from './app.js';

let t: TestApp;
let storage: StorageService;
const TOKEN = 'test-release-token-0123456789abcdef0123456789';

beforeAll(async () => {
  process.env.RELEASE_TOKEN = TOKEN;
  t = await createTestApp();
  storage = t.app.get(StorageService);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await rm(storage.downloads, { recursive: true, force: true });
  await storage.onModuleInit();
});

const bearer = { Authorization: `Bearer ${TOKEN}` };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const putFile = (name: string, body: Buffer, headers: Record<string, string> = bearer) =>
  t.http.put(`/api/admin/releases/files/${encodeURIComponent(name)}`).set(headers).set('Content-Type', 'application/octet-stream').send(body);

describe('public download list', () => {
  it('is empty until something is published, and needs no login', async () => {
    const res = await t.http.get('/api/downloads');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ release: null });
  });
});

describe('publishing a release', () => {
  const exe = randomBytes(5000);
  const deb = randomBytes(3000);

  async function publish() {
    expect((await putFile('Notes-1.2.0-setup.exe', exe)).status).toBe(200);
    expect((await putFile('notes_1.2.0_amd64.deb', deb)).status).toBe(200);
    expect((await putFile('latest.yml', Buffer.from('version: 1.2.0\n'))).status).toBe(200);
    return t.http.post('/api/admin/releases').set(bearer).send({
      version: '1.2.0',
      notes: 'Dark mode and faster sync',
      files: [
        { name: 'Notes-1.2.0-setup.exe', os: 'windows', arch: 'x64', format: 'nsis' },
        { name: 'notes_1.2.0_amd64.deb', os: 'linux', arch: 'x64', format: 'deb' },
      ],
    });
  }

  it('computes size and SHA-256 from the files it actually holds', async () => {
    const res = await publish();
    expect(res.status).toBe(200);
    const list = (await t.http.get('/api/downloads')).body.release;
    expect(list.version).toBe('1.2.0');
    expect(list.notes).toBe('Dark mode and faster sync');
    const win = list.files.find((f: { os: string }) => f.os === 'windows');
    expect(win).toMatchObject({ name: 'Notes-1.2.0-setup.exe', size: exe.length, sha256: sha(exe), format: 'nsis' });
    const linux = list.files.find((f: { os: string }) => f.os === 'linux');
    expect(linux.sha256).toBe(sha(deb));
  });

  it('serves the files as attachments, resumable, and the updater feed uncached', async () => {
    await publish();
    const file = await t.http.get('/downloads/Notes-1.2.0-setup.exe').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toBe('attachment');
    expect((file.body as Buffer).equals(exe)).toBe(true);

    const part = await t.http.get('/downloads/Notes-1.2.0-setup.exe').set('Range', 'bytes=10-19');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${exe.length}`);

    const feed = await t.http.get('/downloads/latest.yml');
    expect(feed.status).toBe(200);
    expect(feed.headers['cache-control']).toBe('no-cache');
    expect(feed.text).toContain('version: 1.2.0');
  });

  it('replaces the previous release when a new one is published', async () => {
    await publish();
    await putFile('Notes-1.3.0-setup.exe', randomBytes(100));
    await t.http.post('/api/admin/releases').set(bearer).send({
      version: '1.3.0',
      files: [{ name: 'Notes-1.3.0-setup.exe', os: 'windows', arch: 'x64', format: 'nsis' }],
    });
    const rel = (await t.http.get('/api/downloads')).body.release;
    expect(rel.version).toBe('1.3.0');
    expect(rel.files).toHaveLength(1);
  });

  it('refuses to publish a file that was never uploaded', async () => {
    const res = await t.http.post('/api/admin/releases').set(bearer).send({
      version: '2.0.0',
      files: [{ name: 'ghost.exe', os: 'windows', arch: 'x64', format: 'nsis' }],
    });
    expect(res.status).toBe(422);
    expect((await t.http.get('/api/downloads')).body.release).toBeNull();
  });

  it('validates the manifest', async () => {
    const bad = (body: unknown) => t.http.post('/api/admin/releases').set(bearer).send(body as object);
    expect((await bad({ version: 'latest', files: [] })).status).toBe(400);
    expect((await bad({ version: '1.0.0', files: [] })).status).toBe(400);
    expect((await bad({ version: '1.0.0', files: [{ name: 'a.exe', os: 'mac', arch: 'x64', format: 'nsis' }] })).status).toBe(400);
  });
});

describe('who may publish', () => {
  it('rejects a missing or wrong token', async () => {
    expect((await putFile('a.exe', Buffer.from('x'), {})).status).toBe(401);
    expect((await putFile('a.exe', Buffer.from('x'), { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await t.http.post('/api/admin/releases').send({ version: '1.0.0', files: [] })).status).toBe(401);
    // a normal user's access token is not a release token
    const user = await t.http.post('/api/auth/register').send({ email: `rel${Date.now()}@example.com`, password: 'correct horse battery', displayName: 'x' });
    expect((await putFile('a.exe', Buffer.from('x'), { Authorization: `Bearer ${user.body.accessToken}` })).status).toBe(401);
  });

  it('does not exist at all when no release token is configured', async () => {
    const saved = process.env.RELEASE_TOKEN;
    process.env.RELEASE_TOKEN = '';
    const bare = await createTestApp();
    try {
      expect((await bare.http.put('/api/admin/releases/files/a.exe').set(bearer).send(Buffer.from('x'))).status).toBe(404);
      expect((await bare.http.post('/api/admin/releases').set(bearer).send({})).status).toBe(404);
      expect((await bare.http.get('/api/downloads')).status).toBe(200); // the public list still works
    } finally {
      await bare.close();
      process.env.RELEASE_TOKEN = saved;
    }
  });
});

describe('file name safety', () => {
  it.each([
    ['a script', 'install.sh'],
    ['a dotfile', '.env'],
    ['traversal', '../evil.exe'],
    ['a nested path', 'a/b.exe'],
    ['a Windows path', '..\\evil.exe'],
    ['the manifest itself', 'manifest.json'],
    ['a name with a NUL', 'a%00.exe'],
    ['no extension', 'notes'],
  ])('refuses %s', async (_label, name) => {
    const res = await t.http.put(`/api/admin/releases/files/${name.replace(/\//g, '%2F').replace(/\\/g, '%5C')}`).set(bearer).send(Buffer.from('x'));
    expect([400, 404]).toContain(res.status);
    expect((await t.http.get('/api/downloads')).body.release).toBeNull();
  });

  it('cannot be used to read files outside the downloads folder', async () => {
    for (const path of ['/downloads/..%2f..%2f.env', '/downloads/../uploads', '/downloads/%2e%2e/%2e%2e/.env', '/downloads/..%5c..%5c.env']) {
      const res = await t.http.get(path);
      expect(res.status, path).not.toBe(200);
      expect(res.text ?? '').not.toContain('JWT_ACCESS_SECRET');
    }
  });

  it('rejects an empty upload', async () => {
    expect((await putFile('empty.exe', Buffer.alloc(0))).status).toBe(400);
  });
});

describe('health', () => {
  it('answers 200 when the database is reachable, without login', async () => {
    const res = await t.http.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
