import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { MaintenanceService } from '../src/media/maintenance.service.js';
import { QuotaPolicy } from '../src/quota/quota.policy.js';
import { QuotaService } from '../src/quota/quota.service.js';
import { createTestApp, type TestApp } from './app.js';
import { builders, para, signup, usedBytes, uuid, type Account } from './helpers.js';

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

let t: TestApp;
let me: Account;
let b: ReturnType<typeof builders>;
let quota: QuotaService;

beforeAll(async () => {
  t = await createTestApp();
  quota = t.app.get(QuotaService);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.prisma.quotaOverride.deleteMany();
  await t.prisma.user.deleteMany();
  me = await signup(t);
  b = builders(t, me);
});

const noisePng = (side: number) =>
  sharp({
    create: {
      width: side,
      height: side,
      channels: 3,
      background: '#000',
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    },
  })
    .png()
    .toBuffer();

const upload = (file: Buffer, id = uuid()) =>
  t.http.post('/api/media').set(me.auth).field('id', id).attach('file', file, 'n.png');
const setLimit = (storageBytes: number, userId = me.id) =>
  t.prisma.quotaOverride.create({
    data: {
      id: uuid(),
      scope: 'user',
      scopeId: userId,
      storageBytes: BigInt(storageBytes),
      updatedBy: userId,
    },
  });
const save = (pageId: string, content: object, baseVersion: number) =>
  t.http.post(`/api/pages/${pageId}/snapshots/replace`).set(me.auth).send({ content, baseVersion });

describe('limitFor', () => {
  it('uses the override over the environment default, and the default again once it is cleared', async () => {
    const def = quota.defaults('user').storageBytes;
    expect(def).toBe(2048 * MB);
    expect((await quota.limitFor('user', me.id)).storageBytes).toBe(def);

    await setLimit(1234);
    expect((await quota.limitFor('user', me.id)).storageBytes).toBe(1234);
    expect((await t.http.get('/api/me').set(me.auth)).body.quota.limit).toBe(1234);

    await t.prisma.quotaOverride.deleteMany({ where: { scopeId: me.id } });
    expect((await quota.limitFor('user', me.id)).storageBytes).toBe(def);
  });

  it('knows team and project defaults from the environment', () => {
    expect(quota.defaults('team')).toEqual({
      storageBytes: 10240 * MB,
      maxMembers: 100,
      maxProjects: 50,
      maxFileBytes: 0,
    });
    expect(quota.defaults('project').storageBytes).toBe(0); // limited only by the team
  });
});

describe('uploads', () => {
  it('refuse with 413 and the details when the file does not fit, storing nothing', async () => {
    const img = await noisePng(40);
    await setLimit(img.length - 1);

    const res = await upload(img);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      code: 'quota_exceeded',
      message: 'quota_exceeded',
      scope: 'user',
      limit: img.length - 1,
      used: 0,
      requested: img.length,
    });
    expect(await t.prisma.media.count({ where: { userId: me.id } })).toBe(0);
    expect(await usedBytes(t, me.id)).toBe(0);
  });

  it('leave no file behind when refused', async () => {
    const img = await noisePng(40);
    await setLimit(10);
    const id = uuid();
    expect((await upload(img, id)).status).toBe(413);
    const { StorageService } = await import('../src/media/storage.service.js');
    const { stat } = await import('node:fs/promises');
    const path = t.app.get(StorageService).mediaPath(me.id, id);
    await expect(stat(path)).rejects.toThrow();
  });

  it('cannot be raced past the limit: of two that together do not fit, exactly one is stored', async () => {
    const a = await noisePng(40);
    const c = await noisePng(41);
    await setLimit(Math.max(a.length, c.length) + 10);

    const results = await Promise.all([upload(a), upload(c)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 413]);
    expect(await t.prisma.media.count({ where: { userId: me.id } })).toBe(1);
    const stored = results.find((r) => r.status === 201)!.body.size as number;
    expect(await usedBytes(t, me.id)).toBe(stored);
  });

  it('honours a lower maximum file size set for the account', async () => {
    const img = await noisePng(40);
    await t.prisma.quotaOverride.create({
      data: {
        id: uuid(),
        scope: 'user',
        scopeId: me.id,
        maxFileBytes: BigInt(img.length - 1),
        updatedBy: me.id,
      },
    });
    const res = await upload(img);
    expect(res.status).toBe(413);
    expect(res.body.message).toBe('image_too_large');
  });
});

describe('documents', () => {
  it('count toward usage: creating, growing and shrinking a page', async () => {
    const empty = await usedBytes(t, me.id);
    expect(empty).toBe(0);
    const page = await b.page((await b.category((await b.notebook()).id)).id);
    const afterCreate = await usedBytes(t, me.id);
    expect(afterCreate).toBeGreaterThan(0);
    expect((await t.prisma.page.findUniqueOrThrow({ where: { id: page.id } })).sizeBytes).toBe(
      afterCreate,
    );

    const doc = para('x'.repeat(5000));
    expect((await save(page.id, doc, 0)).status).toBe(200);
    const grown = await usedBytes(t, me.id);
    const stored = await t.prisma.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(grown).toBeGreaterThan(5000);
    expect(stored.sizeBytes).toBe(grown);
    expect(stored.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(stored.content))); // the stored (normalised) document

    expect((await save(page.id, para('short'), 1)).status).toBe(200);
    const shrunk = await t.prisma.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(shrunk.sizeBytes).toBeLessThan(200);
    expect(await usedBytes(t, me.id)).toBe(shrunk.sizeBytes);
  });

  it('are refused as a whole when they do not fit, and the old text stays', async () => {
    const page = await b.page((await b.category((await b.notebook()).id)).id);
    await setLimit((await usedBytes(t, me.id)) + 100);

    const res = await save(page.id, para('y'.repeat(2000)), 0);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: 'quota_exceeded', scope: 'user' });
    const row = await t.prisma.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(row.version).toBe(0);
    expect(JSON.stringify(row.content)).not.toContain('yyyy');
    expect(await usedBytes(t, me.id)).toBe(row.sizeBytes);

    // text that fits still saves while the limit is nearly reached
    expect((await save(page.id, para('ok'), 0)).status).toBe(200);
  });

  it('a page cannot be created when there is no room even for an empty one', async () => {
    const cat = await b.category((await b.notebook()).id);
    await setLimit(1);
    const res = await t.http
      .post('/api/pages')
      .set(me.auth)
      .send({ id: uuid(), categoryId: cat.id, title: 'x', position: 'a0' });
    expect(res.status).toBe(413);
  });

  it('are refunded by the trash purge but not by a soft delete', async () => {
    const maintenance = t.app.get(MaintenanceService);
    const nb = await b.notebook();
    const cat = await b.category(nb.id);
    const page = await b.page(cat.id);
    await save(page.id, para('z'.repeat(3000)), 0);
    const used = await usedBytes(t, me.id);
    expect(used).toBeGreaterThan(3000);

    await t.http.delete(`/api/pages/${page.id}`).set(me.auth);
    expect(await usedBytes(t, me.id)).toBe(used); // soft delete: still counted

    await t.prisma.page.update({
      where: { id: page.id },
      data: { deletedAt: new Date(Date.now() - 31 * DAY) },
    });
    await maintenance.purgeTrash();
    expect(await t.prisma.page.findUnique({ where: { id: page.id } })).toBeNull();
    expect(await usedBytes(t, me.id)).toBe(0);
  });

  it('are refunded when a purged notebook takes its pages with it', async () => {
    const maintenance = t.app.get(MaintenanceService);
    const nb = await b.notebook();
    const cat = await b.category(nb.id);
    const p1 = await b.page(cat.id);
    await save(p1.id, para('q'.repeat(1000)), 0);
    const keep = await b.page((await b.category((await b.notebook()).id)).id);
    const keepSize = (await t.prisma.page.findUniqueOrThrow({ where: { id: keep.id } })).sizeBytes;

    await t.http.delete(`/api/notebooks/${nb.id}`).set(me.auth);
    const old = { deletedAt: new Date(Date.now() - 31 * DAY) };
    await t.prisma.page.updateMany({ where: { notebookId: nb.id }, data: old });
    await t.prisma.category.updateMany({ where: { notebookId: nb.id }, data: old });
    await t.prisma.notebook.update({ where: { id: nb.id }, data: old });
    await maintenance.purgeTrash();

    expect(await usedBytes(t, me.id)).toBe(keepSize);
  });

  it('count in the breakdown next to images and video', async () => {
    const page = await b.page((await b.category((await b.notebook()).id)).id);
    await save(page.id, para('w'.repeat(500)), 0);
    const img = await noisePng(20);
    expect((await upload(img)).status).toBe(201);

    const res = await t.http.get('/api/me/storage').set(me.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scope: 'user', images: img.length, video: 0 });
    expect(res.body.documents).toBeGreaterThan(500);
    expect(res.body.used).toBe(res.body.images + res.body.video + res.body.documents);
  });
});

describe('QuotaPolicy', () => {
  it('can be replaced: a custom policy supplies the defaults, overrides still win', async () => {
    class SmallPolicy extends QuotaPolicy {
      defaults() {
        return { storageBytes: 777, maxMembers: 3, maxProjects: 2, maxFileBytes: 0 };
      }
    }
    const custom = await createTestApp((builder) =>
      builder.overrideProvider(QuotaPolicy).useClass(SmallPolicy),
    );
    try {
      const who = await signup(custom);
      const me2 = (await custom.http.get('/api/me').set(who.auth)).body;
      expect(me2.quota).toMatchObject({ limit: 777, used: 0 });
      const svc = custom.app.get(QuotaService);
      expect((await svc.limitFor('team', uuid())).maxMembers).toBe(3);

      await custom.prisma.quotaOverride.create({
        data: { id: uuid(), scope: 'user', scopeId: who.id, storageBytes: 5n, updatedBy: who.id },
      });
      expect((await svc.limitFor('user', who.id)).storageBytes).toBe(5);
      expect((await svc.limitFor('user', who.id)).maxMembers).toBe(0 + 3); // fields without an override still follow the policy
    } finally {
      await custom.close();
    }
  });
});
