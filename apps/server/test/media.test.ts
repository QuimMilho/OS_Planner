import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { StorageService } from '../src/media/storage.service.js';
import { createTestApp, type TestApp } from './app.js';
import { brokenPng, exe, fakeMp4, html, jpegWithExif, png, svg, truncatedJpegWithExif } from './fixtures.js';
import { signup, uuid, type Account, usedBytes } from './helpers.js';

let t: TestApp;
let me: Account;
let storage: StorageService;

beforeAll(async () => {
  t = await createTestApp();
  storage = t.app.get(StorageService);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.prisma.user.deleteMany();
  me = await signup(t);
});

const upload = (who: Account, file: Buffer, filename = 'file.bin', fields: Record<string, string | number> = {}) => {
  const req = t.http.post('/api/media').set(who.auth).field('id', String(fields['id'] ?? uuid()));
  for (const [k, v] of Object.entries(fields)) if (k !== 'id') req.field(k, String(v));
  return req.attach('file', file, { filename });
};

const mediaToken = async (who: Account) =>
  (await t.http.post('/api/auth/media-token').set(who.auth)).body.token as string;

describe('uploading', () => {
  it('requires a verified email', async () => {
    const unverified = await signup(t, false);
    const res = await upload(unverified, await png());
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('email_not_verified');
  });

  it('requires authentication', async () => {
    const res = await t.http.post('/api/media').field('id', uuid()).attach('file', await png(), 'a.png');
    expect(res.status).toBe(401);
  });

  it('stores an image, measures it, and charges the quota', async () => {
    const buf = await png(40, 30);
    const res = await upload(me, buf, 'photo.png');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'image', mime: 'image/png', width: 40, height: 30, size: buf.length });
    const used = await usedBytes(t, me.id);
    expect(used).toBe(buf.length);
    const onDisk = await readFile(storage.mediaPath(me.id, res.body.id));
    expect(onDisk.equals(buf)).toBe(true);
  });

  it('ignores the file name and Content-Type: the bytes decide', async () => {
    const res = await upload(me, await png(), 'totally-a-video.mp4');
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('image');
  });

  it('accepts a video and records the client-supplied dimensions and duration', async () => {
    const res = await upload(me, fakeMp4(), 'clip.mp4', { width: 1280, height: 720, durationSec: 12.5 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'video', mime: 'video/mp4', width: 1280, height: 720, durationSec: 12.5 });
  });

  it('is idempotent: retrying with the same id returns the same record and charges nothing twice', async () => {
    const id = uuid();
    const buf = await png();
    const first = await upload(me, buf, 'a.png', { id });
    const retry = await upload(me, buf, 'a.png', { id });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(await t.prisma.media.count({ where: { userId: me.id } })).toBe(1);
    const used = await usedBytes(t, me.id);
    expect(used).toBe(buf.length);
  });

  it("refuses an id that belongs to another user and leaves their file alone", async () => {
    const eve = await signup(t);
    const id = uuid();
    const theirs = await png(10, 10, '#00ff00');
    await upload(eve, theirs, 'a.png', { id });
    const res = await upload(me, await png(), 'a.png', { id });
    expect(res.status).toBe(409);
    expect((await readFile(storage.mediaPath(eve.id, id))).equals(theirs)).toBe(true);
  });

  it.each([
    ['SVG (can carry script)', svg, 'logo.svg'],
    ['HTML disguised as a PNG', html, 'x.png'],
    ['an executable disguised as a PNG', exe, 'x.png'],
  ])('rejects %s', async (_label, buf, name) => {
    const res = await upload(me, buf, name);
    expect(res.status).toBe(415);
    expect(await t.prisma.media.count()).toBe(0);
    expect(await usedBytes(t, me.id)).toBe(0);
  });

  it('rejects a PNG signature followed by garbage as an unsupported type', async () => {
    const res = await upload(me, brokenPng, 'x.png');
    expect(res.status).toBe(415);
    expect(await t.prisma.media.count()).toBe(0);
  });

  it('rejects a JPEG that cannot be re-encoded, without charging quota or keeping files', async () => {
    const res = await upload(me, await truncatedJpegWithExif(), 'cut.jpg');
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('invalid_image');
    expect(await t.prisma.media.count()).toBe(0);
    expect(await usedBytes(t, me.id)).toBe(0);
  });

  it('leaves no temporary files behind after rejected uploads', async () => {
    await upload(me, svg, 'a.svg');
    await upload(me, exe, 'a.png');
    await upload(me, await truncatedJpegWithExif(), 'cut.jpg');
    await upload(me, Buffer.alloc(0), 'empty.png').catch(() => undefined);
    expect(await readdir(storage.tmp)).toEqual([]);
  });

  it('requires a file and a valid id', async () => {
    expect((await t.http.post('/api/media').set(me.auth).field('id', uuid())).status).toBe(422);
    expect((await upload(me, await png(), 'a.png', { id: 'not-a-uuid' })).status).toBe(400);
  });

  it('strips EXIF (location, owner, description) from JPEGs and applies the rotation', async () => {
    const original = await jpegWithExif(20, 10);
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const res = await upload(me, original, 'photo.jpg');
    expect(res.status).toBe(201);
    const stored = await readFile(storage.mediaPath(me.id, res.body.id));
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect(stored.includes(Buffer.from('SECRET-OWNER'))).toBe(false);
    // Orientation 6 means "rotate 90°", so the 20x10 picture is stored as 10x20.
    expect([meta.width, meta.height]).toEqual([10, 20]);
    expect([res.body.width, res.body.height]).toEqual([10, 20]);
    expect(res.body.size).toBe(stored.length);
  });
});

describe('serving', () => {
  let id: string;
  let body: Buffer;
  beforeEach(async () => {
    body = fakeMp4(5000);
    id = (await upload(me, body, 'v.mp4')).body.id;
  });

  it('serves with a media token and sandboxing headers', async () => {
    const res = await t.http.get(`/api/media/${id}?t=${await mediaToken(me)}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('video/mp4');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect((res.body as Buffer).equals(body)).toBe(true);
  });

  it('also accepts a bearer access token', async () => {
    expect((await t.http.get(`/api/media/${id}`).set(me.auth)).status).toBe(200);
  });

  it('supports Range requests so video can seek', async () => {
    const token = await mediaToken(me);
    const res = await t.http
      .get(`/api/media/${id}?t=${token}`)
      .set('Range', 'bytes=100-199')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100-199/${body.length}`);
    expect((res.body as Buffer).equals(body.subarray(100, 200))).toBe(true);
  });

  it('rejects missing, garbage and wrong-kind tokens', async () => {
    expect((await t.http.get(`/api/media/${id}`)).status).toBe(401);
    expect((await t.http.get(`/api/media/${id}?t=garbage`)).status).toBe(401);
    // an access token in the query string is not a media token
    expect((await t.http.get(`/api/media/${id}?t=${me.token}`)).status).toBe(401);
  });

  it("answers 404 (not 403) for someone else's media, even with a valid token of their own", async () => {
    const eve = await signup(t);
    expect((await t.http.get(`/api/media/${id}?t=${await mediaToken(eve)}`)).status).toBe(404);
    expect((await t.http.get(`/api/media/${id}`).set(eve.auth)).status).toBe(404);
  });
});
