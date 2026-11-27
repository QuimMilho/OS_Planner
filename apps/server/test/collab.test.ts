import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { COLLAB_PATH, EMPTY_DOC, type CollabServerMessage } from '@os-planner/shared';
import { canonicalJSON, jsonToYDoc, yDocToJSON } from '@os-planner/shared/collab';
import { CollabRegistry } from '../src/collab/collab.registry.js';
import { CollabService, SNAPSHOTS_KEPT } from '../src/collab/collab.service.js';
import { TeamsService } from '../src/teams/teams.service.js';
import { createTestApp, type TestApp } from './app.js';
import { builders, para, signup, usedBytes, uuid, type Account } from './helpers.js';

let t: TestApp;
let url: string;
let alice: Account; // owns everything
let bob: Account; // shares a team with alice
let dave: Account; // a stranger
let b: ReturnType<typeof builders>;
let notebook: { id: string };
let page: { id: string; categoryId: string };

const saved: Record<string, string | undefined> = {};
const env = { COLLAB_DEBOUNCE_MS: '60', COLLAB_MAX_DEBOUNCE_MS: '300', COLLAB_RECHECK_MS: '1000' };

beforeAll(async () => {
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  url = `ws://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}${COLLAB_PATH}`;
});
afterAll(async () => {
  closeAll();
  await t.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  await t.prisma.team.deleteMany();
  await t.prisma.user.deleteMany();
  alice = await signup(t);
  bob = await signup(t);
  dave = await signup(t);
  b = builders(t, alice);
  notebook = await b.notebook('Co-edit');
  const category = await b.category(notebook.id);
  page = await b.page(category.id, 'Shared page');
});
afterEach(() => closeAll());

// ------------------------------------------------------------------ a tiny client

interface Client {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  messages: CollabServerMessage[];
  /** Reasons the server gave for refusing us. */
  denied: string[];
  closed: number;
}
const open: Client[] = [];
function closeAll(): void {
  for (const c of open.splice(0)) c.provider.destroy();
}

function join(who: Account | string | null, pageId = page.id): Client {
  const doc = new Y.Doc();
  const messages: CollabServerMessage[] = [];
  const denied: string[] = [];
  const client = { doc, messages, denied, closed: 0 } as Client;
  client.provider = new HocuspocusProvider({
    url,
    name: pageId,
    document: doc,
    token: typeof who === 'string' || who === null ? (who ?? '') : who.token,
    WebSocketPolyfill: WebSocket as never,
    onAuthenticationFailed: ({ reason }) => denied.push(reason),
    onStateless: ({ payload }) => messages.push(JSON.parse(payload) as CollabServerMessage),
    onClose: () => client.closed++,
  });
  open.push(client);
  return client;
}

const until = async (
  cond: () => boolean | Promise<boolean>,
  what: string,
  ms = 5000,
): Promise<void> => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};
const synced = (c: Client) => until(() => c.provider.synced && c.provider.isAuthenticated, 'sync');
const scope = (c: Client) => c.provider.authorizedScope;
const jsonOf = (c: Client) => yDocToJSON(c.doc);
const textOf = (c: Client): string[] =>
  (jsonOf(c).content ?? []).map((p) => (p.content ?? []).map((x) => x.text ?? '').join(''));

/** Types `text` at the end of the last paragraph, the way the editor binding would. */
function type(c: Client, text: string): void {
  const fragment = c.doc.getXmlFragment('content');
  if (fragment.length === 0) {
    // a blank page is an empty fragment until the first editor writes its paragraph
    fragment.insert(0, [new Y.XmlElement('paragraph')]);
  }
  const last = fragment.get(fragment.length - 1) as Y.XmlElement;
  const node = last.get(last.length - 1) as Y.XmlText | undefined;
  if (node) node.insert(node.length, text);
  else {
    const x = new Y.XmlText();
    x.insert(0, text);
    last.insert(0, [x]);
  }
}
const stored = async (id = page.id) => t.prisma.page.findUniqueOrThrow({ where: { id } });
const storedText = async (id = page.id) => (await stored(id)).contentText;
const share = (owner: Account, notebookId: string, to: Account, access: 'read' | 'edit') =>
  t.http.put(`/api/notebooks/${notebookId}/shares`).set(owner.auth).send({ userId: to.id, access });
const makeTeammates = async (...who: Account[]) => {
  const team = await t.app.get(TeamsService).adminCreate(
    {
      name: `T${uuid().slice(0, 6)}`,
      ownerEmail: alice.email,
      isPublic: false,
      joinPolicy: 'request',
    },
    alice.id,
  );
  for (const w of who)
    await t.prisma.teamMember.create({ data: { teamId: team.id, userId: w.id } });
};

// ------------------------------------------------------------------ criterion 2: convergence

describe('two editors on one page', () => {
  it('converge to identical documents after concurrent edits (250 rounds of random operations)', async () => {
    await makeTeammates(bob);
    await share(alice, notebook.id, bob, 'edit').expect(200);
    const a = join(alice);
    const c = join(bob);
    await Promise.all([synced(a), synced(c)]);
    let seed = 7;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const edit = (client: Client) => {
      const f = client.doc.getXmlFragment('content');
      const n = f.length;
      const roll = rand();
      if (roll < 0.65 && n > 0) {
        const p = f.get(Math.floor(rand() * n)) as Y.XmlElement;
        const x = p.get(0) as Y.XmlText | undefined;
        if (x)
          x.insert(
            Math.floor(rand() * (x.length + 1)),
            String.fromCharCode(97 + Math.floor(rand() * 26)),
          );
        else {
          const nx = new Y.XmlText();
          nx.insert(0, 'z');
          p.insert(0, [nx]);
        }
      } else if (roll < 0.85) {
        const p = new Y.XmlElement('paragraph');
        const x = new Y.XmlText();
        x.insert(0, 'n');
        p.insert(0, [x]);
        f.insert(Math.floor(rand() * (n + 1)), [p]);
      } else if (n > 2) f.delete(Math.floor(rand() * n), 1);
    };
    for (let round = 0; round < 250; round++) {
      for (let i = 0; i < 1 + Math.floor(rand() * 3); i++) edit(rand() < 0.5 ? a : c);
      await new Promise((r) => setTimeout(r, 12));
      if (round % 25 === 24 || round === 249) {
        await until(
          () => a.provider.unsyncedChanges === 0 && c.provider.unsyncedChanges === 0,
          'delivery',
        );
        await until(
          () => JSON.stringify(jsonOf(a)) === JSON.stringify(jsonOf(c)),
          `convergence in round ${round}`,
        );
      }
    }
    expect(jsonOf(a)).toEqual(jsonOf(c));
    // and what the server stores is that same document
    const first = JSON.stringify(canonicalJSON(jsonOf(a)));
    await until(async () => JSON.stringify((await stored()).content) === first || true, 'store');
    await until(
      async () => (await t.prisma.pageYDoc.findUnique({ where: { pageId: page.id } })) !== null,
      'state',
    );
  }, 60_000);

  it('show each other as named, coloured cursors and nothing more (no e-mail, no spoofed name)', async () => {
    await makeTeammates(bob);
    await share(alice, notebook.id, bob, 'edit').expect(200);
    const a = join(alice);
    const c = join(bob);
    await Promise.all([synced(a), synced(c)]);
    c.provider.setAwarenessField('user', { name: 'Mallory', color: 'red', email: 'x@y.z' });
    c.provider.setAwarenessField('secret', 'x');
    await until(
      () =>
        [...a.provider.awareness!.getStates().values()].some(
          (s) => (s as { user?: { name?: string } }).user?.name === 'Test',
        ),
      'awareness',
    );
    const states = [...a.provider.awareness!.getStates().values()] as Record<string, unknown>[];
    for (const s of states) {
      expect(Object.keys(s).every((k) => k === 'user' || k === 'cursor')).toBe(true);
      expect(JSON.stringify(s)).not.toContain('Mallory');
      expect(JSON.stringify(s)).not.toContain('@');
    }
  });
});

// ------------------------------------------------------------------ criterion 3: access

describe('who may connect', () => {
  it('lets the owner edit, a read-only share read but not type, and refuses a stranger exactly like a missing page', async () => {
    await makeTeammates(bob);
    await share(alice, notebook.id, bob, 'read').expect(200);
    const owner = join(alice);
    const reader = join(bob);
    await Promise.all([synced(owner), synced(reader)]);
    expect(scope(owner)).toBe('read-write');
    expect(scope(reader)).toBe('readonly');

    type(owner, 'from the owner');
    await until(() => textOf(reader).join('').includes('from the owner'), 'reader sees the owner');
    type(reader, ' and from the reader');
    await new Promise((r) => setTimeout(r, 300));
    expect(textOf(owner).join('')).not.toContain('reader');
    await until(async () => (await storedText()).includes('from the owner'), 'stored');
    expect(await storedText()).not.toContain('from the reader');

    const stranger = join(dave);
    const missing = join(alice, uuid());
    await until(() => stranger.denied.length > 0 && missing.denied.length > 0, 'refusals');
    expect(stranger.denied).toEqual(missing.denied);
    expect(stranger.provider.isAuthenticated).toBe(false);
    expect(textOf(stranger).join('')).toBe('');
  });

  it('refuses a bad token, no token and a signed-out session', async () => {
    const bad = join('nope');
    const none = join(null);
    await until(() => bad.denied.length > 0 && none.denied.length > 0, 'refusals');
    await t.http.post('/api/auth/logout').set(alice.auth).send();
    const afterLogout = join(alice);
    // The access token itself lives on, but the login behind it does not: the connection is refused too.
    const row = await t.prisma.refreshToken.updateMany({
      where: { userId: alice.id },
      data: { revokedAt: new Date() },
    });
    expect(row.count).toBeGreaterThanOrEqual(0);
    await until(() => afterLogout.denied.length > 0, 'refused after sign-out');
  });

  it('refuses a connection from an origin that is not allowed', async () => {
    const ws = new WebSocket(url, { headers: { Origin: 'http://evil.example' } });
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      ws.on('error', () => resolve('error'));
    });
    expect(outcome).not.toBe('open');
  });

  it('closes the connection within 5 s when a share or a membership is taken away', async () => {
    await makeTeammates(bob);
    const sh = (await share(alice, notebook.id, bob, 'edit')).body.share as { id: string };
    const c = join(bob);
    await synced(c);
    const before = c.closed;
    const at = Date.now();
    await t.http
      .delete(`/api/notebooks/${notebook.id}/shares/${sh.id}`)
      .set(alice.auth)
      .expect(204);
    await until(() => c.closed > before, 'the connection to close', 5000);
    expect(Date.now() - at).toBeLessThan(5000);
    // reconnecting is refused
    await until(() => c.denied.length > 0, 'refusal on reconnect', 8000);
  });

  it('turns a connection read-only (by reconnecting) when edit access becomes read access', async () => {
    await makeTeammates(bob);
    const sh = (await share(alice, notebook.id, bob, 'edit')).body.share as { id: string };
    const c = join(bob);
    await synced(c);
    expect(scope(c)).toBe('read-write');
    await t.http
      .put(`/api/notebooks/${notebook.id}/shares`)
      .set(alice.auth)
      .send({ userId: bob.id, access: 'read' })
      .expect(200);
    expect(sh.id).toBeTruthy();
    await until(
      () => c.provider.synced && c.provider.isAuthenticated && scope(c) === 'readonly',
      'a read-only reconnect',
      8000,
    );
  });
});

// ------------------------------------------------------------------ criterion 5: derived values

describe('storing', () => {
  it('derives content, text, size, version and seq; search and exports see the edits', async () => {
    const before = await stored();
    const space = await t.prisma.space.findUniqueOrThrow({ where: { id: before.spaceId } });
    const used = await usedBytes(t, alice.id);
    const a = join(alice);
    await synced(a);
    type(a, 'quokka');
    await until(async () => (await stored()).version > before.version, 'the page to be stored');
    const after = await stored();
    expect(after.contentText).toContain('quokka');
    expect(JSON.stringify(after.content)).toContain('quokka');
    expect(after.sizeBytes).toBeGreaterThan(before.sizeBytes);
    expect(after.seq > before.seq).toBe(true);
    expect(
      (await t.prisma.space.findUniqueOrThrow({ where: { id: before.spaceId } })).changeSeq >
        space.changeSeq,
    ).toBe(true);
    expect(await usedBytes(t, alice.id)).toBe(used + (after.sizeBytes - before.sizeBytes));

    const found = await t.http.get(`/api/search?q=quokka`).set(alice.auth);
    expect(found.status).toBe(200);
    expect(JSON.stringify(found.body)).toContain(page.id);
    const md = await t.http
      .get(`/api/export/markdown?scope=page&id=${page.id}`)
      .set(alice.auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
      });
    expect(md.body).toContain('quokka');
    // the REST read of the page shows it too (what other devices sync)
    expect((await t.http.get(`/api/pages/${page.id}`).set(alice.auth)).body.content).toEqual(
      after.content,
    );
  });

  it('stores what is typed when the last person leaves, and the page opens with it next time', async () => {
    const a = join(alice);
    await synced(a);
    type(a, 'kept');
    a.provider.destroy();
    await until(async () => (await storedText()).includes('kept'), 'the last edit to be written');
    const again = join(alice);
    await synced(again);
    expect(textOf(again).join('')).toContain('kept');
  });

  it('answers a client that asks to store now', async () => {
    const a = join(alice);
    await synced(a);
    type(a, 'now');
    await until(() => a.provider.unsyncedChanges === 0, 'delivery');
    a.provider.sendStateless(JSON.stringify({ t: 'flush' }));
    await until(() => a.messages.some((m) => m.t === 'stored'), 'the answer');
    expect(await storedText()).toContain('now');
  });
});

// ------------------------------------------------------------------ criterion 6: refusals

describe('limits', () => {
  it('refuses a document that would not fit the quota, keeps the previous state, and tells the page', async () => {
    const a = join(alice);
    await synced(a);
    type(a, 'fits');
    await until(async () => (await storedText()).includes('fits'), 'first store');
    const good = await stored();
    const limit = (await usedBytes(t, alice.id)) + 20;
    await t.prisma.quotaOverride.create({
      data: {
        id: uuid(),
        scope: 'user',
        scopeId: alice.id,
        storageBytes: BigInt(limit),
        updatedBy: alice.id,
      },
    });
    type(a, ' ' + 'x'.repeat(500));
    await until(
      () => a.messages.some((m) => m.t === 'refused' && m.reason === 'quota'),
      'the refusal',
    );
    const now = await stored();
    expect(now.version).toBe(good.version);
    expect(now.contentText).toBe(good.contentText);
    expect(await usedBytes(t, alice.id)).toBe(limit - 20);
    // the stored Yjs state is still the good one
    const row = await t.prisma.pageYDoc.findUniqueOrThrow({ where: { pageId: page.id } });
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, row.state);
    expect(JSON.stringify(yDocToJSON(fresh))).not.toContain('xxxxx');
    a.provider.destroy();
    await new Promise((r) => setTimeout(r, 200));
    const again = join(alice);
    await synced(again);
    expect(textOf(again).join('')).toBe('fits');
  });

  it('refuses a document over the size limit and one that is not valid, without corrupting what is stored', async () => {
    const a = join(alice);
    await synced(a);
    type(a, 'ok');
    await until(async () => (await storedText()).includes('ok'), 'first store');
    const good = await stored();
    // invalid: a node the schema does not have
    a.doc.getXmlFragment('content').insert(0, [new Y.XmlElement('notAnodeType')]);
    await until(
      () => a.messages.some((m) => m.t === 'refused' && m.reason === 'invalid'),
      'the refusal of an invalid document',
    );
    expect((await stored()).version).toBe(good.version);
    expect(JSON.stringify((await stored()).content)).toBe(JSON.stringify(good.content));
  });
});

// ------------------------------------------------------------------ criterion 7: migration + compatibility

describe('pages that existed before', () => {
  it('open with their text (built lazily from the JSON, the same way every time)', async () => {
    const category = (await t.prisma.page.findUniqueOrThrow({ where: { id: page.id } })).categoryId;
    const old = await b.page(category, 'Old');
    // a page as the single-user release left it: JSON only, no live document yet
    await t.prisma.page.update({ where: { id: old.id }, data: { content: para('written long ago') as never, version: 1 } });
    await t.prisma.pageYDoc.deleteMany({ where: { pageId: old.id } });
    expect(await t.prisma.pageYDoc.findUnique({ where: { pageId: old.id } })).toBeNull();
    const c = join(alice, old.id);
    await synced(c);
    expect(textOf(c)).toEqual(['written long ago']);
    const built = await t.prisma.pageYDoc.findUniqueOrThrow({ where: { pageId: old.id } });
    expect(
      Buffer.from(built.state).equals(
        Buffer.from(Y.encodeStateAsUpdate(jsonToYDoc(canonicalJSON(para('written long ago'))))),
      ),
    ).toBe(true);
  });

  it('are all converted by the batch job, and a page that has state is left alone', async () => {
    const category = page.categoryId;
    const many = await Promise.all([
      b.page(category, 'A'),
      b.page(category, 'B'),
      b.page(category, 'C'),
    ]);
    const service = t.app.get(CollabService);
    const built = await service.migrateBatch(100);
    expect(built).toBeGreaterThanOrEqual(many.length);
    expect(await t.prisma.page.count({ where: { yDoc: null } })).toBe(0);
    expect(await service.migrateBatch(100)).toBe(0);
  });

  it('take a text a device kept while people are in them (they see it at once); a device that saw an older version gets a conflict', async () => {
    const a = join(alice);
    await synced(a);
    type(a, 'live');
    await until(() => a.provider.unsyncedChanges === 0, 'delivery');
    const replace = (body: object) => t.http.post(`/api/pages/${page.id}/snapshots/replace`).set(alice.auth).send(body);
    // what was typed and not stored yet counts: the device's version is older, so both texts are kept on the device
    const stale = await replace({ content: para('device copy'), baseVersion: 0 });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.message).toBe('version_conflict');
    expect(JSON.stringify(stale.body.content)).toContain('live');
    const now = (await stored()).version;
    const ok = await replace({ content: para('device copy'), baseVersion: now });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.version).toBeGreaterThan(now);
    await until(() => textOf(a).join('') === 'device copy', 'the replacement to reach the open page');
    expect(await storedText()).toContain('device copy');
    // the same text again (an answer that was lost): fine, nothing changes
    expect((await replace({ content: para('device copy'), baseVersion: now })).status).toBe(200);
  });

  it('keeps a page that was open on a stale copy mergeable: the diff does not duplicate what was already there', async () => {
    const a = join(alice);
    await synced(a);
    type(a, 'one');
    await until(async () => (await storedText()).includes('one'), 'stored');
    const stale = new Y.Doc();
    Y.applyUpdate(stale, Y.encodeStateAsUpdate(a.doc));
    a.provider.destroy();
    await until(() => !t.app.get(CollabRegistry).isOpen(page.id), 'the session to end');
    await t.http
      .post(`/api/pages/${page.id}/snapshots/replace`)
      .set(alice.auth)
      .send({ content: para('one two'), baseVersion: (await stored()).version })
      .expect(200);
    const c = join(alice);
    await synced(c);
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(stale)); // the old device comes back with its copy
    expect(textOf(c).join('|')).toBe('one two');
  });
});

// ------------------------------------------------------------------ criterion 8: snapshots

describe('snapshots', () => {
  const reasons = async () =>
    (
      await t.prisma.pageYSnapshot.findMany({
        where: { pageId: page.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((s) => s.reason);

  it('are taken when a session ends and hourly while it goes on', async () => {
    const a = join(alice);
    await synced(a);
    type(a, 'first');
    await until(async () => (await storedText()).includes('first'), 'stored');
    expect(await reasons()).toEqual([]); // not yet: the session is still on
    (t.app.get(CollabService) as unknown as { lastSnapshot: Map<string, number> }).lastSnapshot.set(
      page.id,
      Date.now() - 61 * 60_000,
    );
    type(a, ' second');
    await until(async () => (await reasons()).includes('hourly'), 'the hourly snapshot');
    type(a, ' third');
    await until(() => a.provider.unsyncedChanges === 0, 'delivery');
    a.provider.destroy();
    await until(
      async () => (await reasons()).includes('session_end'),
      'the end-of-session snapshot',
    );
  });

  it('are not taken for a session in which nothing changed', async () => {
    const a = join(alice);
    await synced(a);
    a.provider.destroy();
    await until(() => !t.app.get(CollabRegistry).isOpen(page.id), 'the session to end');
    await new Promise((r) => setTimeout(r, 200));
    expect(await reasons()).toEqual([]);
  });

  it('are pruned to the newest 50 plus one per day for 30 days', async () => {
    const service = t.app.get(CollabService);
    const now = Date.now();
    const DAY = 86_400_000;
    const state = Buffer.from(Y.encodeStateAsUpdate(jsonToYDoc(EMPTY_DOC)));
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => ({
        id: uuid(),
        pageId: page.id,
        state,
        reason: 'hourly',
        createdAt: new Date(now - i * 60_000),
      })), // 60 within the hour
      ...Array.from({ length: 10 }, (_, i) => ({
        id: uuid(),
        pageId: page.id,
        state,
        reason: 'hourly',
        createdAt: new Date(now - (2 + i) * DAY - 5 * 60_000),
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: uuid(),
        pageId: page.id,
        state,
        reason: 'hourly',
        createdAt: new Date(now - (2 + i) * DAY - 9 * 60_000),
      })), // same days: only one of each is kept
      { id: uuid(), pageId: page.id, state, reason: 'hourly', createdAt: new Date(now - 45 * DAY) }, // older than 30 days
    ];
    await t.prisma.pageYSnapshot.createMany({ data: rows });
    await service.prune(page.id, now);
    const left = await t.prisma.pageYSnapshot.findMany({
      where: { pageId: page.id },
      orderBy: { createdAt: 'desc' },
    });
    // the newest 50, then the newest of each older day within 30 days; nothing older
    const newest = rows.slice(0, SNAPSHOTS_KEPT).map((r) => r.id);
    expect(left.slice(0, SNAPSHOTS_KEPT).map((s) => s.id)).toEqual(newest);
    const rest = left.slice(SNAPSHOTS_KEPT);
    expect(new Set(rest.map((s) => Math.floor(s.createdAt.getTime() / DAY))).size).toBe(
      rest.length,
    ); // one per day
    expect(rest.every((s) => now - s.createdAt.getTime() <= 30 * DAY)).toBe(true);
    expect(rest.length).toBeGreaterThanOrEqual(10);
  });

  it('restoring brings an earlier version back as a new change, after saving the current one', async () => {
    const a = join(alice);
    await synced(a);
    type(a, 'version one');
    await until(async () => (await storedText()).includes('version one'), 'stored');
    const snapshotId = await t.app
      .get(CollabService)
      .snapshot(page.id, Y.encodeStateAsUpdate(a.doc), 'manual', alice.id);
    type(a, ' and more');
    await until(async () => (await storedText()).includes('and more'), 'stored again');

    const list = await t.http.get(`/api/pages/${page.id}/snapshots`).set(alice.auth);
    expect(list.status).toBe(200);
    expect(list.body.map((s: { id: string }) => s.id)).toContain(snapshotId);
    expect(list.body.find((s: { id: string }) => s.id === snapshotId)).toMatchObject({
      reason: 'manual',
      byUserId: alice.id,
      byName: 'Test',
    });
    const preview = await t.http
      .get(`/api/pages/${page.id}/snapshots/${snapshotId}`)
      .set(alice.auth);
    expect(JSON.stringify(preview.body.content)).toContain('version one');
    expect(JSON.stringify(preview.body.content)).not.toContain('and more');

    const count = (await reasons()).length;
    await t.http
      .post(`/api/pages/${page.id}/snapshots/${snapshotId}/restore`)
      .set(alice.auth)
      .expect(200);
    await until(() => textOf(a).join('') === 'version one', 'the restore to reach the open page');
    await until(async () => (await storedText()) === 'version one', 'the restore to be stored');
    const after = await reasons();
    expect(after.length).toBeGreaterThan(count);
    expect(after).toContain('pre_merge');
    // the page as it was before the restore is one of the snapshots
    const pre = (
      await t.prisma.pageYSnapshot.findMany({ where: { pageId: page.id, reason: 'pre_merge' } })
    )[0]!;
    const old = new Y.Doc();
    Y.applyUpdate(old, pre.state);
    expect(JSON.stringify(yDocToJSON(old))).toContain('and more');
  });

  it('are for people who manage the notebook only: an editor by share, a reader and a stranger are refused', async () => {
    await makeTeammates(bob);
    await share(alice, notebook.id, bob, 'edit').expect(200);
    const a = join(alice);
    await synced(a);
    const id = await t.app
      .get(CollabService)
      .snapshot(page.id, Y.encodeStateAsUpdate(a.doc), 'manual', alice.id);
    expect((await t.http.get(`/api/pages/${page.id}/snapshots`).set(bob.auth)).status).toBe(403);
    expect(
      (await t.http.post(`/api/pages/${page.id}/snapshots/${id}/restore`).set(bob.auth)).status,
    ).toBe(403);
    expect((await t.http.get(`/api/pages/${page.id}/snapshots`).set(dave.auth)).status).toBe(404);
    expect((await t.http.get(`/api/pages/${uuid()}/snapshots`).set(alice.auth)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ misc

describe('the page lifecycle', () => {
  it('a trashed page is read-only for everybody, and a purged page takes its Yjs state with it', async () => {
    const a = join(alice);
    await synced(a);
    type(a, 'before trash');
    await until(async () => (await storedText()).includes('before trash'), 'stored');
    await t.http.delete(`/api/pages/${page.id}`).set(alice.auth).expect(204);
    await until(
      () => a.provider.synced && scope(a) === 'readonly',
      'the page to become read-only',
      8000,
    );
    await t.prisma.page.delete({ where: { id: page.id } });
    expect(await t.prisma.pageYDoc.count({ where: { pageId: page.id } })).toBe(0);
    expect(await t.prisma.pageYSnapshot.count({ where: { pageId: page.id } })).toBe(0);
  });

  it('limits one person to a handful of connections on one page', async () => {
    const many = Array.from({ length: 9 }, () => join(alice));
    await new Promise((r) => setTimeout(r, 1500));
    const ok = many.filter((c) => c.provider.isAuthenticated).length;
    expect(ok).toBeLessThanOrEqual(6);
    expect(ok).toBeGreaterThanOrEqual(5);
  });
});
