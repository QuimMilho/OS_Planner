import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';
import { builders, para, signup, uuid, type Account } from './helpers.js';

let t: TestApp;
let me: Account;
let b: ReturnType<typeof builders>;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.prisma.user.deleteMany();
  me = await signup(t);
  b = builders(t, me);
});

const get = (url: string, who = me) => t.http.get(url).set(who.auth);

describe('notebooks', () => {
  it('creates a notebook with a default General category when created over REST', async () => {
    const nb = await b.notebook('Physics');
    expect(nb).toMatchObject({ name: 'Physics', deletedAt: null });
    const tree = await get(`/api/notebooks/${nb.id}/tree`);
    expect(tree.status).toBe(200);
    expect(tree.body.categories.map((c: { name: string }) => c.name)).toEqual(['General']);
  });

  it('is idempotent: repeating a create returns the same notebook', async () => {
    const id = uuid();
    const body = { id, name: 'Once', position: 'a0' };
    const first = await t.http.post('/api/notebooks').set(me.auth).send(body);
    const second = await t.http.post('/api/notebooks').set(me.auth).send({ ...body, name: 'Changed' });
    expect(first.status).toBe(201);
    expect(second.body.id).toBe(id);
    expect(second.body.name).toBe('Once'); // create never overwrites
    expect(await t.prisma.notebook.count({ where: { userId: me.id } })).toBe(1);
  });

  it('orders by position using binary comparison, not the case-insensitive DB collation', async () => {
    for (const [name, position] of [['lower', 'a0'], ['upper', 'Zz'], ['mid', 'a5']] as const) {
      await t.http.post('/api/notebooks').set(me.auth).send({ id: uuid(), name, position });
    }
    const list = await get('/api/notebooks');
    // In ASCII "Zz" < "a0" < "a5". A case-insensitive ORDER BY would put "Zz" last.
    expect(list.body.map((n: { name: string }) => n.name)).toEqual(['upper', 'lower', 'mid']);
  });

  it('renames and validates names', async () => {
    const nb = await b.notebook();
    const ok = await t.http.patch(`/api/notebooks/${nb.id}`).set(me.auth).send({ name: 'Renamed', color: '#3b5bdb' });
    expect(ok.body).toMatchObject({ name: 'Renamed', color: '#3b5bdb' });
    expect((await t.http.patch(`/api/notebooks/${nb.id}`).set(me.auth).send({ name: '   ' })).status).toBe(400);
    expect((await t.http.patch(`/api/notebooks/${nb.id}`).set(me.auth).send({ color: 'red' })).status).toBe(400);
  });

  it('deleting trashes everything inside; restoring brings back only what went with it', async () => {
    const nb = await b.notebook();
    const keep = await b.category(nb.id, 'Trashed earlier');
    const live = await b.category(nb.id, 'Live');
    const earlier = await b.page(keep.id, 'Earlier');
    const inside = await b.page(live.id, 'Inside');
    await t.http.delete(`/api/categories/${keep.id}`).set(me.auth); // trashed before the notebook

    expect((await t.http.delete(`/api/notebooks/${nb.id}`).set(me.auth)).status).toBe(204);
    expect((await get('/api/notebooks')).body).toHaveLength(0);
    expect((await get(`/api/notebooks/${nb.id}/tree`)).status).toBe(404);
    expect((await get(`/api/pages/${inside.id}`)).body.deletedAt).not.toBeNull();

    expect((await t.http.post(`/api/notebooks/${nb.id}/restore`).set(me.auth)).status).toBe(200);
    const tree = (await get(`/api/notebooks/${nb.id}/tree`)).body;
    const names = tree.categories.map((c: { name: string }) => c.name);
    expect(names).toContain('Live');
    expect(names).not.toContain('Trashed earlier'); // stays in the trash
    expect(tree.pages.map((p: { id: string }) => p.id)).toContain(inside.id);
    expect(tree.pages.map((p: { id: string }) => p.id)).not.toContain(earlier.id);
  });

  it('deleting twice is harmless', async () => {
    const nb = await b.notebook();
    expect((await t.http.delete(`/api/notebooks/${nb.id}`).set(me.auth)).status).toBe(204);
    expect((await t.http.delete(`/api/notebooks/${nb.id}`).set(me.auth)).status).toBe(204);
  });
});

describe('ownership isolation', () => {
  it("another user cannot see, change, delete or restore someone else's items (always 404)", async () => {
    const nb = await b.notebook();
    const cat = await b.category(nb.id);
    const pg = await b.page(cat.id);
    const eve = await signup(t);

    const attempts = [
      t.http.get(`/api/notebooks/${nb.id}/tree`).set(eve.auth),
      t.http.patch(`/api/notebooks/${nb.id}`).set(eve.auth).send({ name: 'pwned' }),
      t.http.post(`/api/notebooks/${nb.id}/restore`).set(eve.auth),
      t.http.patch(`/api/categories/${cat.id}`).set(eve.auth).send({ name: 'pwned' }),
      t.http.get(`/api/pages/${pg.id}`).set(eve.auth),
      t.http.patch(`/api/pages/${pg.id}`).set(eve.auth).send({ title: 'pwned' }),
      t.http.put(`/api/pages/${pg.id}/content`).set(eve.auth).send({ content: para('pwned'), baseVersion: 0 }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);

    // creating inside someone else's notebook/category also looks like "not found"
    const intoNb = await t.http.post('/api/categories').set(eve.auth).send({ id: uuid(), notebookId: nb.id, name: 'x', position: 'a0' });
    const intoCat = await t.http.post('/api/pages').set(eve.auth).send({ id: uuid(), categoryId: cat.id, title: 'x', position: 'a0' });
    expect(intoNb.status).toBe(404);
    expect(intoCat.status).toBe(404);

    // deletes by a stranger are silently ignored and change nothing
    await t.http.delete(`/api/notebooks/${nb.id}`).set(eve.auth);
    await t.http.delete(`/api/pages/${pg.id}`).set(eve.auth);
    expect((await get(`/api/pages/${pg.id}`)).body.deletedAt).toBeNull();
    expect((await get('/api/notebooks')).body).toHaveLength(1);
    expect((await get(`/api/pages/${pg.id}`)).body.title).toBe('Page');
  });

  it('refuses to create an entity with an id that belongs to another user', async () => {
    const nb = await b.notebook();
    const eve = await signup(t);
    const res = await t.http.post('/api/notebooks').set(eve.auth).send({ id: nb.id, name: 'mine now', position: 'a0' });
    expect(res.status).toBe(409);
    expect((await get('/api/notebooks')).body[0].name).toBe(nb.name);
  });
});

describe('categories', () => {
  it('nests, and refuses to exceed the depth limit', async () => {
    const nb = await b.notebook();
    let parent: string | null = null;
    for (let i = 0; i < 8; i++) parent = (await b.category(nb.id, `L${i + 1}`, parent)).id;
    const tooDeep = await t.http
      .post('/api/categories')
      .set(me.auth)
      .send({ id: uuid(), notebookId: nb.id, parentId: parent, name: 'L9', position: 'a0' });
    expect(tooDeep.status).toBe(422);
  });

  it('refuses to move a category into itself or its own descendant', async () => {
    const nb = await b.notebook();
    const a = await b.category(nb.id, 'A');
    const child = await b.category(nb.id, 'B', a.id);
    const grandchild = await b.category(nb.id, 'C', child.id);
    for (const target of [a.id, child.id, grandchild.id]) {
      const res = await t.http.patch(`/api/categories/${a.id}`).set(me.auth).send({ parentId: target });
      expect(res.status).toBe(422);
    }
    // a legal move still works
    const ok = await t.http.patch(`/api/categories/${grandchild.id}`).set(me.auth).send({ parentId: a.id });
    expect(ok.body.parentId).toBe(a.id);
  });

  it('refuses a move that would push the subtree past the depth limit', async () => {
    const nb = await b.notebook();
    let deep: string | null = null;
    for (let i = 0; i < 7; i++) deep = (await b.category(nb.id, `D${i}`, deep)).id;
    const sub = await b.category(nb.id, 'Root');
    await b.category(nb.id, 'Child', sub.id); // subtree height 2
    const res = await t.http.patch(`/api/categories/${sub.id}`).set(me.auth).send({ parentId: deep }); // 7 + 2 = 9 > 8
    expect(res.status).toBe(422);
  });

  it('cannot attach to a parent from a different notebook', async () => {
    const n1 = await b.notebook();
    const n2 = await b.notebook();
    const foreign = await b.category(n2.id, 'Elsewhere');
    const res = await t.http
      .post('/api/categories')
      .set(me.auth)
      .send({ id: uuid(), notebookId: n1.id, parentId: foreign.id, name: 'x', position: 'a0' });
    expect(res.status).toBe(404);
  });

  it('deleting a category trashes its subtree and pages; restore brings them back', async () => {
    const nb = await b.notebook();
    const top = await b.category(nb.id, 'Top');
    const sub = await b.category(nb.id, 'Sub', top.id);
    const p1 = await b.page(top.id);
    const p2 = await b.page(sub.id);
    const other = await b.category(nb.id, 'Other');
    const p3 = await b.page(other.id);

    await t.http.delete(`/api/categories/${top.id}`).set(me.auth);
    const tree = (await get(`/api/notebooks/${nb.id}/tree`)).body;
    expect(tree.categories.map((c: { id: string }) => c.id)).not.toContain(top.id);
    expect(tree.categories.map((c: { id: string }) => c.id)).not.toContain(sub.id);
    expect(tree.pages.map((p: { id: string }) => p.id)).toEqual([p3.id]);

    expect((await t.http.post(`/api/categories/${top.id}/restore`).set(me.auth)).status).toBe(200);
    const back = (await get(`/api/notebooks/${nb.id}/tree`)).body;
    expect(back.categories.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([top.id, sub.id, other.id]));
    expect(back.pages.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([p1.id, p2.id, p3.id]));
  });

  it('cannot restore a category whose parent is still in the trash', async () => {
    const nb = await b.notebook();
    const top = await b.category(nb.id, 'Top');
    const sub = await b.category(nb.id, 'Sub', top.id);
    await t.http.delete(`/api/categories/${sub.id}`).set(me.auth);
    await t.http.delete(`/api/categories/${top.id}`).set(me.auth);
    expect((await t.http.post(`/api/categories/${sub.id}/restore`).set(me.auth)).status).toBe(409);
    expect((await t.http.post(`/api/categories/${top.id}/restore`).set(me.auth)).status).toBe(200);
    expect((await t.http.post(`/api/categories/${sub.id}/restore`).set(me.auth)).status).toBe(200);
  });

  it('cannot create into a trashed notebook', async () => {
    const nb = await b.notebook();
    await t.http.delete(`/api/notebooks/${nb.id}`).set(me.auth);
    const res = await t.http.post('/api/categories').set(me.auth).send({ id: uuid(), notebookId: nb.id, name: 'x', position: 'a0' });
    expect(res.status).toBe(409);
  });
});

describe('pages', () => {
  it('renames, reorders and moves between categories and notebooks', async () => {
    const n1 = await b.notebook();
    const n2 = await b.notebook();
    const c1 = await b.category(n1.id);
    const c2 = await b.category(n2.id);
    const pg = await b.page(c1.id, 'Draft');

    const renamed = await t.http.patch(`/api/pages/${pg.id}`).set(me.auth).send({ title: 'Final', position: 'a9' });
    expect(renamed.body).toMatchObject({ title: 'Final', position: 'a9' });

    const moved = await t.http.patch(`/api/pages/${pg.id}`).set(me.auth).send({ categoryId: c2.id });
    expect(moved.body).toMatchObject({ categoryId: c2.id, notebookId: n2.id });
    expect((await get(`/api/pages?notebookId=${n1.id}`)).body).toHaveLength(0);
    expect((await get(`/api/pages?notebookId=${n2.id}`)).body).toHaveLength(1);
  });

  it('starts empty at version 0 and can be trashed and restored', async () => {
    const cat = await b.category((await b.notebook()).id);
    const pg = await b.page(cat.id);
    const full = (await get(`/api/pages/${pg.id}`)).body;
    expect(full.version).toBe(0);
    expect(full.content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });

    await t.http.delete(`/api/pages/${pg.id}`).set(me.auth);
    expect((await get(`/api/pages?categoryId=${cat.id}`)).body).toHaveLength(0);
    expect((await t.http.post(`/api/pages/${pg.id}/restore`).set(me.auth)).status).toBe(200);
    expect((await get(`/api/pages?categoryId=${cat.id}`)).body).toHaveLength(1);
  });

  it('cannot restore a page whose category is in the trash', async () => {
    const cat = await b.category((await b.notebook()).id);
    const pg = await b.page(cat.id);
    await t.http.delete(`/api/pages/${pg.id}`).set(me.auth);
    await t.http.delete(`/api/categories/${cat.id}`).set(me.auth);
    expect((await t.http.post(`/api/pages/${pg.id}/restore`).set(me.auth)).status).toBe(409);
  });
});

describe('page content and optimistic concurrency', () => {
  let pageId: string;
  beforeEach(async () => {
    pageId = (await b.page((await b.category((await b.notebook()).id)).id)).id;
  });
  const put = (content: unknown, baseVersion: number, who = me) =>
    t.http.put(`/api/pages/${pageId}/content`).set(who.auth).send({ content, baseVersion });

  it('saves content, bumps the version, and derives searchable text', async () => {
    const res = await put(para('Hello wörld'), 0);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 1 });
    const row = await t.prisma.page.findUniqueOrThrow({ where: { id: pageId } });
    expect(row.version).toBe(1);
    expect(row.contentText).toBe('Hello wörld');
    const stored = (await get(`/api/pages/${pageId}`)).body;
    expect(stored.version).toBe(1);
    expect(stored.content.type).toBe('doc');
    expect(stored.content.content[0].content[0].text).toBe('Hello wörld');
  });

  it('returns 409 with the server version and content when the base version is stale', async () => {
    await put(para('first'), 0);
    await put(para('second, from device A'), 1);
    const stale = await put(para('from device B, based on version 1'), 1); // B never saw version 2
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ message: 'version_conflict', version: 2 });
    expect(JSON.stringify(stale.body.content)).toContain('second, from device A');
    // the stale write changed nothing
    expect((await get(`/api/pages/${pageId}`)).body.version).toBe(2);
  });

  it('treats a retried request whose first attempt succeeded as success, not as a conflict', async () => {
    const first = await put(para('same content'), 0);
    const retry = await put(para('same content'), 0); // response was "lost", client resends
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ version: 1 });
  });

  it('rejects invalid documents without touching the stored one', async () => {
    await put(para('keep me'), 0);
    for (const bad of [
      { type: 'doc', content: [{ type: 'script', attrs: { src: 'x' } }] },
      { type: 'paragraph' },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] },
    ]) {
      const res = await put(bad, 1);
      expect(res.status).toBe(422);
      expect(res.body.message).toBe('invalid_document');
    }
    expect((await get(`/api/pages/${pageId}`)).body.version).toBe(1);
  });

  it('rejects references to media the user does not own', async () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'imageFigure', attrs: { mediaId: uuid(), alt: '', caption: '', width: null, align: 'center' } }],
    };
    const res = await put(doc, 0);
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('unknown_media');
  });

  it('links owned media to the page and unlinks it when the content stops using it', async () => {
    const mediaId = uuid();
    await t.prisma.media.create({
      data: { id: mediaId, userId: me.id, kind: 'image', mime: 'image/png', size: 10, storageKey: 'x' },
    });
    const withImage = { type: 'doc', content: [{ type: 'imageFigure', attrs: { mediaId, alt: 'a', caption: '', width: 50, align: 'left' } }] };
    expect((await put(withImage, 0)).status).toBe(200);
    expect(await t.prisma.pageMedia.count({ where: { pageId } })).toBe(1);
    expect((await put(para('no image any more'), 1)).status).toBe(200);
    expect(await t.prisma.pageMedia.count({ where: { pageId } })).toBe(0);
  });

  it("cannot reference another user's media even if the id is known", async () => {
    const eve = await signup(t);
    const mediaId = uuid();
    await t.prisma.media.create({ data: { id: mediaId, userId: eve.id, kind: 'image', mime: 'image/png', size: 10, storageKey: 'x' } });
    const doc = { type: 'doc', content: [{ type: 'imageFigure', attrs: { mediaId, alt: '', caption: '', width: null, align: 'center' } }] };
    expect((await put(doc, 0)).status).toBe(422);
  });

  it('refuses to write to a trashed page', async () => {
    await t.http.delete(`/api/pages/${pageId}`).set(me.auth);
    expect((await put(para('x'), 0)).status).toBe(404);
  });

  it('two simultaneous writes from the same base version: exactly one wins', async () => {
    const results = await Promise.all([put(para('writer one'), 0), put(para('writer two'), 0)]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
  });
});
