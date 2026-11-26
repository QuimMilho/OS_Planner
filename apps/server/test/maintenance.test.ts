import { stat } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceService } from '../src/media/maintenance.service.js';
import { StorageService } from '../src/media/storage.service.js';
import { createTestApp, type TestApp } from './app.js';
import { png } from './fixtures.js';
import { builders, signup, uuid, type Account, usedBytes } from './helpers.js';

let t: TestApp;
let me: Account;
let b: ReturnType<typeof builders>;
let maintenance: MaintenanceService;
let storage: StorageService;

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const exists = (p: string) => stat(p).then(() => true, () => false);

beforeAll(async () => {
  t = await createTestApp();
  maintenance = t.app.get(MaintenanceService);
  storage = t.app.get(StorageService);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.prisma.user.deleteMany();
  me = await signup(t);
  b = builders(t, me);
});

const uploadImage = async () => {
  const res = await t.http.post('/api/media').set(me.auth).field('id', uuid()).attach('file', await png(), 'a.png');
  expect(res.status).toBe(201);
  return res.body as { id: string; size: number };
};

describe('orphan media collection', () => {
  it('removes old unreferenced uploads and returns the space, but keeps referenced and recent ones', async () => {
    const page = await b.page((await b.category((await b.notebook()).id)).id);
    const used = await uploadImage();
    const oldOrphan = await uploadImage();
    const recentOrphan = await uploadImage();

    const doc = { type: 'doc', content: [{ type: 'imageFigure', attrs: { mediaId: used.id, alt: '', caption: '', width: null, align: 'center' } }] };
    expect((await t.http.put(`/api/pages/${page.id}/content`).set(me.auth).send({ content: doc, baseVersion: 0 })).status).toBe(200);

    await t.prisma.media.updateMany({ where: { id: { in: [used.id, oldOrphan.id] } }, data: { createdAt: daysAgo(10) } });
    const before = await usedBytes(t, me.id);

    expect(await maintenance.collectOrphanMedia()).toBe(1);

    expect(await t.prisma.media.findUnique({ where: { id: oldOrphan.id } })).toBeNull();
    expect(await exists(storage.mediaPath(me.id, oldOrphan.id))).toBe(false);
    expect(await t.prisma.media.findUnique({ where: { id: used.id } })).not.toBeNull();
    expect(await exists(storage.mediaPath(me.id, used.id))).toBe(true);
    expect(await t.prisma.media.findUnique({ where: { id: recentOrphan.id } })).not.toBeNull();
    const after = await usedBytes(t, me.id);
    expect(after).toBe(before - oldOrphan.size);
  });

  it('keeps media that is only referenced by a page sitting in the trash', async () => {
    const page = await b.page((await b.category((await b.notebook()).id)).id);
    const img = await uploadImage();
    const doc = { type: 'doc', content: [{ type: 'imageFigure', attrs: { mediaId: img.id, alt: '', caption: '', width: null, align: 'center' } }] };
    await t.http.put(`/api/pages/${page.id}/content`).set(me.auth).send({ content: doc, baseVersion: 0 });
    await t.http.delete(`/api/pages/${page.id}`).set(me.auth);
    await t.prisma.media.update({ where: { id: img.id }, data: { createdAt: daysAgo(30) } });

    expect(await maintenance.collectOrphanMedia()).toBe(0);
    expect(await t.prisma.media.findUnique({ where: { id: img.id } })).not.toBeNull();
  });
});

describe('trash purge', () => {
  it('permanently removes items trashed more than 30 days ago, including nested categories', async () => {
    const nb = await b.notebook('Old');
    const top = await b.category(nb.id, 'Top');
    const sub = await b.category(nb.id, 'Sub', top.id);
    const deepPage = await b.page(sub.id, 'deep');
    await t.http.delete(`/api/notebooks/${nb.id}`).set(me.auth);

    const keepNb = await b.notebook('Recent');
    const keepCat = await b.category(keepNb.id);
    const recentlyDeleted = await b.page(keepCat.id, 'deleted yesterday');
    const live = await b.page(keepCat.id, 'live');
    await t.http.delete(`/api/pages/${recentlyDeleted.id}`).set(me.auth);

    // age only the first notebook's trash
    const old = { deletedAt: daysAgo(31) };
    await t.prisma.page.updateMany({ where: { notebookId: nb.id }, data: old });
    await t.prisma.category.updateMany({ where: { notebookId: nb.id }, data: old });
    await t.prisma.notebook.update({ where: { id: nb.id }, data: old });

    const purged = await maintenance.purgeTrash();
    expect(purged.notebooks).toBe(1);
    expect(await t.prisma.notebook.findUnique({ where: { id: nb.id } })).toBeNull();
    expect(await t.prisma.category.count({ where: { id: { in: [top.id, sub.id] } } })).toBe(0);
    expect(await t.prisma.page.findUnique({ where: { id: deepPage.id } })).toBeNull();

    // yesterday's trash and live data are untouched
    expect(await t.prisma.page.findUnique({ where: { id: recentlyDeleted.id } })).not.toBeNull();
    expect(await t.prisma.page.findUnique({ where: { id: live.id } })).not.toBeNull();
  });

  it('deleting a user with nested categories works (regression: parent FK used to block it)', async () => {
    const nb = await b.notebook();
    const a = await b.category(nb.id, 'A');
    const c = await b.category(nb.id, 'B', a.id);
    await b.category(nb.id, 'C', c.id);
    await expect(t.prisma.user.delete({ where: { id: me.id } })).resolves.toBeDefined();
    expect(await t.prisma.category.count()).toBe(0);
  });
});
