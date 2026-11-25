import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_PAGE } from '../src/tree/sync.service.js';
import { createTestApp, type TestApp } from './app.js';
import { builders, signup, uuid, type Account } from './helpers.js';

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
afterEach(() => {
  SYNC_PAGE.limit = 1000;
});

interface Changes {
  cursor: number;
  hasMore: boolean;
  notebooks: { id: string; seq: number; deletedAt: string | null }[];
  categories: { id: string; seq: number; deletedAt: string | null }[];
  pages: { id: string; seq: number; deletedAt: string | null; content?: unknown; title: string }[];
}

const changes = async (since: number, who = me): Promise<Changes> => {
  const res = await t.http.get(`/api/sync/changes?since=${since}`).set(who.auth);
  expect(res.status).toBe(200);
  return res.body;
};

/** Follows `hasMore` like the client does and returns everything delivered. */
async function pullAll(since = 0) {
  const all = { notebooks: [] as Changes['notebooks'], categories: [] as Changes['categories'], pages: [] as Changes['pages'] };
  let cursor = since;
  let calls = 0;
  for (;;) {
    const c = await changes(cursor);
    all.notebooks.push(...c.notebooks);
    all.categories.push(...c.categories);
    all.pages.push(...c.pages);
    calls++;
    expect(c.cursor).toBeGreaterThanOrEqual(cursor); // never goes backwards
    if (!c.hasMore) return { ...all, cursor: c.cursor, calls };
    expect(c.cursor).toBeGreaterThan(cursor); // must make progress or the client would loop forever
    cursor = c.cursor;
    if (calls > 100) throw new Error('pull did not terminate');
  }
}

describe('GET /sync/changes', () => {
  it('returns everything for a new device, tombstones included, without page content', async () => {
    const nb = await b.notebook('N');
    const cat = await b.category(nb.id);
    const pg = await b.page(cat.id, 'P');
    const gone = await b.page(cat.id, 'Gone');
    await t.http.delete(`/api/pages/${gone.id}`).set(me.auth);

    const c = await changes(0);
    expect(c.hasMore).toBe(false);
    expect(c.notebooks.map((n) => n.id)).toEqual([nb.id]);
    expect(c.pages.map((p) => p.id).sort()).toEqual([pg.id, gone.id].sort());
    expect(c.pages.find((p) => p.id === gone.id)!.deletedAt).not.toBeNull();
    for (const p of c.pages) expect(p.content).toBeUndefined();
    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(c.cursor).toBe(Number(user.changeSeq));
  });

  it('is incremental: only what changed after the cursor', async () => {
    const nb = await b.notebook();
    const cat = await b.category(nb.id);
    const p1 = await b.page(cat.id, 'one');
    const p2 = await b.page(cat.id, 'two');
    const first = await changes(0);

    expect((await changes(first.cursor)).pages).toHaveLength(0);

    await t.http.patch(`/api/pages/${p1.id}`).set(me.auth).send({ title: 'one renamed' });
    const second = await changes(first.cursor);
    expect(second.pages.map((p) => p.id)).toEqual([p1.id]);
    expect(second.pages[0]!.title).toBe('one renamed');
    expect(second.notebooks).toHaveLength(0);

    await t.http.delete(`/api/pages/${p2.id}`).set(me.auth);
    const third = await changes(second.cursor);
    expect(third.pages.map((p) => [p.id, p.deletedAt !== null])).toEqual([[p2.id, true]]);
  });

  it('a content save is announced so other devices know to refetch', async () => {
    const pg = await b.page((await b.category((await b.notebook()).id)).id);
    const before = (await changes(0)).cursor;
    await t.http.put(`/api/pages/${pg.id}/content`).set(me.auth).send({
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited' }] }] },
      baseVersion: 0,
    });
    const after = await changes(before);
    expect(after.pages).toHaveLength(1);
    expect(after.pages[0]).toMatchObject({ id: pg.id, version: 1 });
  });

  it("never includes another user's rows", async () => {
    await b.page((await b.category((await b.notebook()).id)).id);
    const eve = await signup(t);
    const c = await changes(0, eve);
    expect(c).toMatchObject({ notebooks: [], categories: [], pages: [], hasMore: false });
  });

  it('survives a cursor ahead of the server (e.g. restored database) without erroring', async () => {
    await b.notebook();
    const c = await changes(999_999);
    expect(c.hasMore).toBe(false);
    expect(c.notebooks).toHaveLength(0);
  });

  it('rejects a malformed cursor', async () => {
    expect((await t.http.get('/api/sync/changes?since=-1').set(me.auth)).status).toBe(400);
    expect((await t.http.get('/api/sync/changes?since=abc').set(me.auth)).status).toBe(400);
  });

  describe('pagination', () => {
    it('delivers every row exactly once across pages', async () => {
      SYNC_PAGE.limit = 3;
      const cat = await b.category((await b.notebook()).id);
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push((await b.page(cat.id, `p${i}`)).id);

      const all = await pullAll();
      expect(all.calls).toBeGreaterThan(1);
      expect(all.pages.map((p) => p.id).sort()).toEqual([...ids].sort());
      expect(new Set(all.pages.map((p) => p.id)).size).toBe(ids.length); // no duplicates
    });

    it('does not split a group of rows that share a seq, even when the group exceeds the limit', async () => {
      SYNC_PAGE.limit = 3;
      const nb = await b.notebook();
      const cat = await b.category(nb.id);
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push((await b.page(cat.id, `p${i}`)).id);
      const baseline = (await pullAll()).cursor;

      // One transaction trashes the notebook, its category and all 8 pages under a single seq.
      await t.http.delete(`/api/notebooks/${nb.id}`).set(me.auth);
      const all = await pullAll(baseline);

      expect(all.pages.map((p) => p.id).sort()).toEqual([...ids].sort());
      expect(all.pages.every((p) => p.deletedAt !== null)).toBe(true);
      expect(all.notebooks).toHaveLength(1);
      expect(all.categories).toHaveLength(2); // the REST-created default "General" + the explicit one
    });
  });
});

describe('change sequence under concurrency', () => {
  it('gives parallel writers distinct, gap-free, ordered seq values', async () => {
    const cat = await b.category((await b.notebook()).id);
    const base = Number((await t.prisma.user.findUniqueOrThrow({ where: { id: me.id } })).changeSeq);

    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        t.http.post('/api/pages').set(me.auth).send({ id: uuid(), categoryId: cat.id, title: `p${i}`, position: 'a0' }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);

    const seqs = results.map((r) => r.body.seq as number).sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(N); // distinct
    expect(seqs[0]).toBe(base + 1); // gap-free
    expect(seqs[N - 1]).toBe(base + N);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(Number(user.changeSeq)).toBe(base + N);
  });

  it('a pull running during writes never skips a row', async () => {
    const cat = await b.category((await b.notebook()).id);
    const created = new Set<string>();
    const seen = new Set<string>();
    let cursor = 0;
    let writing = true;

    const writer = (async () => {
      for (let i = 0; i < 30; i++) {
        const res = await t.http.post('/api/pages').set(me.auth).send({ id: uuid(), categoryId: cat.id, title: `w${i}`, position: 'a0' });
        created.add(res.body.id);
      }
      writing = false;
    })();

    const reader = (async () => {
      while (writing) {
        const c = await changes(cursor);
        c.pages.forEach((p) => seen.add(p.id));
        cursor = c.cursor;
      }
      for (let more = true; more; ) {
        const c = await changes(cursor);
        c.pages.forEach((p) => seen.add(p.id));
        cursor = c.cursor;
        more = c.hasMore;
      }
    })();

    await Promise.all([writer, reader]);
    for (const id of created) expect(seen.has(id), `page ${id} was never delivered`).toBe(true);
  });
});

describe('POST /sync/batch', () => {
  const post = (ops: unknown[]) => t.http.post('/api/sync/batch').set(me.auth).send({ ops });

  const buildOps = () => {
    const nbId = uuid();
    const catId = uuid();
    const pageId = uuid();
    return {
      ids: { nbId, catId, pageId },
      ops: [
        { opId: uuid(), type: 'notebook.create', id: nbId, name: 'Offline notebook', position: 'a0' },
        { opId: uuid(), type: 'category.create', id: catId, notebookId: nbId, name: 'General', position: 'a0' },
        { opId: uuid(), type: 'page.create', id: pageId, categoryId: catId, title: 'Written on a plane', position: 'a0' },
      ],
    };
  };

  it('applies a dependent chain created entirely offline, in order', async () => {
    const { ids, ops } = buildOps();
    const res = await post(ops);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual(ops.map((o) => ({ opId: o.opId, ok: true })));
    const tree = await t.http.get(`/api/notebooks/${ids.nbId}/tree`).set(me.auth);
    expect(tree.body.pages.map((p: { id: string }) => p.id)).toEqual([ids.pageId]);
  });

  it('is idempotent: replaying the same batch changes nothing', async () => {
    const { ops } = buildOps();
    await post(ops);
    const replay = await post(ops);
    expect(replay.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(await t.prisma.notebook.count({ where: { userId: me.id } })).toBe(1);
    expect(await t.prisma.category.count({ where: { userId: me.id } })).toBe(1);
    expect(await t.prisma.page.count({ where: { userId: me.id } })).toBe(1);
  });

  it('reports a bad op on its own and still applies the others', async () => {
    const { ops } = buildOps();
    const bad = { opId: uuid(), type: 'notebook.explode', id: uuid() };
    const missingName = { opId: uuid(), type: 'notebook.create', id: uuid(), position: 'a0' };
    const res = await post([bad, ...ops, missingName]);
    const r = res.body.results;
    expect(r[0]).toMatchObject({ opId: bad.opId, ok: false, error: 'invalid' });
    expect(r.slice(1, 4).every((x: { ok: boolean }) => x.ok)).toBe(true);
    expect(r[4]).toMatchObject({ opId: missingName.opId, ok: false, error: 'invalid' });
  });

  it('reports not_found for updates to things that do not exist, but treats deleting them as done', async () => {
    const upd = { opId: uuid(), type: 'page.update', id: uuid(), title: 'x' };
    const del = { opId: uuid(), type: 'page.delete', id: uuid() };
    const res = await post([upd, del]);
    expect(res.body.results[0]).toMatchObject({ ok: false, error: 'not_found' });
    expect(res.body.results[1]).toMatchObject({ ok: true });
  });

  it('reports parent_deleted when the target category is in the trash', async () => {
    const cat = await b.category((await b.notebook()).id);
    await t.http.delete(`/api/categories/${cat.id}`).set(me.auth);
    const res = await post([{ opId: uuid(), type: 'page.create', id: uuid(), categoryId: cat.id, title: 'x', position: 'a0' }]);
    expect(res.body.results[0]).toMatchObject({ ok: false, error: 'parent_deleted' });
  });

  it('reports id_taken for an id owned by someone else', async () => {
    const eve = await signup(t);
    const theirs = await builders(t, eve).notebook();
    const res = await post([{ opId: uuid(), type: 'notebook.create', id: theirs.id, name: 'x', position: 'a0' }]);
    expect(res.body.results[0]).toMatchObject({ ok: false, error: 'id_taken' });
  });

  it('applies updates, moves and deletes queued offline', async () => {
    const nb = await b.notebook();
    const c1 = await b.category(nb.id, 'A');
    const c2 = await b.category(nb.id, 'B');
    const pg = await b.page(c1.id, 'old title');
    const res = await post([
      { opId: uuid(), type: 'page.update', id: pg.id, title: 'new title', categoryId: c2.id },
      { opId: uuid(), type: 'category.update', id: c1.id, name: 'A renamed' },
      { opId: uuid(), type: 'notebook.update', id: nb.id, name: 'N renamed' },
      { opId: uuid(), type: 'category.delete', id: c1.id },
      { opId: uuid(), type: 'category.restore', id: c1.id },
    ]);
    expect(res.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    const tree = (await t.http.get(`/api/notebooks/${nb.id}/tree`).set(me.auth)).body;
    expect(tree.notebook.name).toBe('N renamed');
    expect(tree.pages[0]).toMatchObject({ title: 'new title', categoryId: c2.id });
    expect(tree.categories.find((c: { id: string }) => c.id === c1.id).name).toBe('A renamed');
  });

  it('enforces size limits on the batch', async () => {
    expect((await post([])).status).toBe(400);
    const many = Array.from({ length: 201 }, () => ({ opId: uuid(), type: 'page.delete', id: uuid() }));
    expect((await post(many)).status).toBe(400);
  });
});
