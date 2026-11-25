import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createTestApp, type TestApp } from './app.js';
import { png } from './fixtures.js';
import { signup, uuid, type Account } from './helpers.js';

// Tiny limits so the tests need only a few kilobytes. Set before the app reads its config.
const MAX_IMAGE_BYTES = 5_000;
const QUOTA_BYTES = 20_000;

let t: TestApp;
let me: Account;

beforeAll(async () => {
  process.env.MAX_IMAGE_MB = String(MAX_IMAGE_BYTES / 1024 / 1024);
  process.env.USER_QUOTA_MB = String(QUOTA_BYTES / 1024 / 1024);
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.prisma.user.deleteMany();
  me = await signup(t);
});

const noisePng = (side: number) =>
  sharp({ create: { width: side, height: side, channels: 3, background: '#000', noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
    .png()
    .toBuffer();

const upload = (file: Buffer) =>
  t.http.post('/api/media').set(me.auth).field('id', uuid()).attach('file', file, 'n.png');

describe('size limits and quota', () => {
  it('rejects an image above the per-file limit', async () => {
    const big = await noisePng(60); // noise does not compress: well over 5 KB
    expect(big.length).toBeGreaterThan(MAX_IMAGE_BYTES);
    const res = await upload(big);
    expect(res.status).toBe(413);
    expect(await t.prisma.media.count()).toBe(0);
  });

  it('accepts files under the limit until the quota is used up, then refuses', async () => {
    const small = await noisePng(30);
    expect(small.length).toBeLessThan(MAX_IMAGE_BYTES);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await upload(small)).status);
    expect(statuses[0]).toBe(201);
    expect(statuses.at(-1)).toBe(413);
    const accepted = statuses.filter((s) => s === 201).length;
    expect(accepted).toBe(Math.floor(QUOTA_BYTES / small.length));
    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(Number(user.storageUsedBytes)).toBe(accepted * small.length);
  });

  it('cannot be raced past the quota by parallel uploads', async () => {
    const small = await noisePng(30);
    const results = await Promise.all(Array.from({ length: 15 }, () => upload(small)));
    const accepted = results.filter((r) => r.status === 201).length;
    expect(accepted).toBeLessThanOrEqual(Math.floor(QUOTA_BYTES / small.length));
    expect(accepted).toBeGreaterThan(0);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(Number(user.storageUsedBytes)).toBeLessThanOrEqual(QUOTA_BYTES);
    expect(Number(user.storageUsedBytes)).toBe(accepted * small.length);
    expect(await t.prisma.media.count({ where: { userId: me.id } })).toBe(accepted);
  });

  it('exposes usage and quota on the profile', async () => {
    await upload(await png(5, 5));
    const profile = (await t.http.get('/api/me').set(me.auth)).body;
    expect(profile.storageQuotaBytes).toBe(Math.floor(QUOTA_BYTES));
    expect(profile.storageUsedBytes).toBeGreaterThan(0);
  });
});
