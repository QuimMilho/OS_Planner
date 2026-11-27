import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Permission, permissionsToString } from '@os-planner/shared';
import { PASSWORD_WINDOW_MS } from '../src/sharing/links.service.js';
import { TeamsService } from '../src/teams/teams.service.js';
import { createTestApp, GOOD_PASSWORD, uniqueEmail, type TestApp } from './app.js';
import { png } from './fixtures.js';
import {
  builders,
  para,
  personalSpaceId,
  signup,
  usedBytes,
  uuid,
  type Account,
} from './helpers.js';

const P = Permission;
const bits = (...b: bigint[]): string => permissionsToString(b.reduce((a, x) => a | x, 0n));

let t: TestApp;
let alice: Account; // owns the personal notebooks and the team
let bob: Account; // teammate
let carol: Account; // teammate
let dave: Account; // not in any team
let teamId: string;
let teamSpace: string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.prisma.team.deleteMany();
  await t.prisma.user.deleteMany();
  alice = await signup(t);
  bob = await signup(t);
  carol = await signup(t);
  dave = await signup(t);
  const team = await t.app
    .get(TeamsService)
    .adminCreate(
      { name: 'Share team', ownerEmail: alice.email, isPublic: false, joinPolicy: 'request' },
      alice.id,
    );
  teamId = team.id;
  teamSpace = (await t.prisma.team.findUniqueOrThrow({ where: { id: teamId } })).spaceId;
  for (const who of [bob, carol])
    await t.prisma.teamMember.create({ data: { teamId, userId: who.id } });
});

// ------------------------------------------------------------------ helpers

const put = (who: Account, notebookId: string, body: object) =>
  t.http.put(`/api/notebooks/${notebookId}/shares`).set(who.auth).send(body);
const share = async (owner: Account, notebookId: string, to: Account, access: 'read' | 'edit') => {
  const res = await put(owner, notebookId, { userId: to.id, access });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.share as { id: string };
};
const content = (who: Account, pageId: string, text: string, baseVersion = 0) =>
  t.http
    .post(`/api/pages/${pageId}/snapshots/replace`)
    .set(who.auth)
    .send({ content: para(text), baseVersion });
const tree = (who: Account, notebookId: string) =>
  t.http.get(`/api/notebooks/${notebookId}/tree`).set(who.auth);
const changes = (who: Account, cursors: Record<string, number>) =>
  t.http
    .get('/api/sync/changes')
    .query({ cursors: JSON.stringify(cursors) })
    .set(who.auth);
const link = async (who: Account, notebookId: string, body: object = { access: 'read' }) => {
  const res = await t.http.post(`/api/notebooks/${notebookId}/links`).set(who.auth).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; token: string; url: string };
};
const resolve = (token: string, password?: string) =>
  t.http
    .post('/api/links/resolve')
    .send({ token, ...(password !== undefined ? { password } : {}) });

/** A notebook with one category and one page that has text. */
async function fixture(owner: Account, text = 'hello') {
  const b = builders(t, owner);
  const nb = await b.notebook('Plans');
  const cat = await b.category(nb.id, 'Ideas');
  const page = await b.page(cat.id, 'First');
  expect((await content(owner, page.id, text)).status).toBe(200);
  return { nb, cat, page };
}

async function teamNotebook(owner: Account, space = teamSpace) {
  const id = uuid();
  const res = await t.http
    .post('/api/notebooks')
    .set(owner.auth)
    .send({ id, spaceId: space, name: 'Team book', position: 'a0' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const catId = (await t.prisma.category.findFirstOrThrow({ where: { notebookId: id } })).id;
  return { id, catId };
}

const roleWith = async (name: string, permissions: bigint, members: Account[]) => {
  const res = await t.http
    .post(`/api/teams/${teamId}/roles`)
    .set(alice.auth)
    .send({ name, permissions: permissionsToString(permissions) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const m of members)
    expect(
      (
        await t.http
          .put(`/api/teams/${teamId}/members/${m.id}/roles/${res.body.id}`)
          .set(alice.auth)
      ).status,
    ).toBe(204);
  return res.body.id as string;
};

// ------------------------------------------------------------------ 1. team notebooks per permission bit

describe('team notebooks: one permission per action', () => {
  it('allowed / denied (403) / not a member (404) for every bit', async () => {
    const { id: nbId, catId } = await teamNotebook(alice);
    const seed = builders(t, alice);
    const page = await t.http
      .post('/api/pages')
      .set(alice.auth)
      .send({ id: uuid(), categoryId: catId, title: 'Seed', position: seed.nextPosition() });
    expect(page.status).toBe(201);

    // bob only looks (VIEW_NOTEBOOKS is in @everyone); carol also has each of the other bits through one role apiece
    await roleWith('creator', P.CREATE_NOTEBOOKS, [carol]);
    await roleWith('editor', P.EDIT_PAGES, [carol]);
    await roleWith('deleter', P.DELETE_PAGES, [carol]);
    await roleWith('manager', P.MANAGE_NOTEBOOKS, [carol]);

    const create = (who: Account) =>
      t.http
        .post('/api/notebooks')
        .set(who.auth)
        .send({ id: uuid(), spaceId: teamSpace, name: 'X', position: 'a1' });
    const newPage = (who: Account) =>
      t.http
        .post('/api/pages')
        .set(who.auth)
        .send({ id: uuid(), categoryId: catId, title: 'P', position: 'a1' });
    const write = (who: Account) => content(who, page.body.id, 'changed', page.body.version);
    const trash = (who: Account) => t.http.delete(`/api/pages/${page.body.id}`).set(who.auth);
    const rename = (who: Account) =>
      t.http.patch(`/api/notebooks/${nbId}`).set(who.auth).send({ name: 'Renamed' });
    const read = (who: Account) => tree(who, nbId);

    // viewing
    expect((await read(bob)).status).toBe(200);
    expect((await read(dave)).status).toBe(404); // not a member: it does not exist

    // each action: the viewer is refused, the holder of exactly that bit succeeds, the outsider sees nothing
    expect((await create(bob)).status).toBe(403);
    expect((await newPage(bob)).status).toBe(403);
    expect((await write(bob)).status).toBe(403);
    expect((await rename(bob)).status).toBe(403);
    expect((await trash(bob)).status).toBe(403);
    for (const act of [create, newPage, write, rename, trash])
      expect((await act(dave)).status).toBe(404);

    expect((await create(carol)).status).toBe(201);
    expect((await newPage(carol)).status).toBe(201);
    expect((await write(carol)).status).toBe(200);
    expect((await rename(carol)).status).toBe(200);
    expect((await trash(carol)).status).toBe(204);
  });

  it('a bit alone is not enough: DELETE without VIEW, or write without EDIT, is refused', async () => {
    const { id: nbId, catId } = await teamNotebook(alice);
    const page = (
      await t.http
        .post('/api/pages')
        .set(alice.auth)
        .send({ id: uuid(), categoryId: catId, title: 'Seed', position: 'a0' })
    ).body;
    await roleWith('only-delete', P.DELETE_PAGES, [bob]);
    expect((await content(bob, page.id, 'nope')).status).toBe(403);
    expect((await t.http.delete(`/api/pages/${page.id}`).set(bob.auth)).status).toBe(204);
    expect((await tree(bob, nbId)).status).toBe(200);
  });
});

describe('notebook overwrites', () => {
  const setOverwrite = (who: Account, body: object) =>
    t.http.put('/api/overwrites').set(who.auth).send(body);

  it('denying VIEW_NOTEBOOKS on one notebook hides it everywhere (404), allowing EDIT_PAGES lets a viewer write', async () => {
    const hidden = await teamNotebook(alice);
    const open = await teamNotebook(alice);
    const everyone = (await t.http.get(`/api/teams/${teamId}/roles`).set(alice.auth)).body.find(
      (r: { isEveryone: boolean }) => r.isEveryone,
    );

    // bob sees both, then the first one is hidden from him by name
    expect((await tree(bob, hidden.id)).status).toBe(200);
    const res = await setOverwrite(alice, {
      targetKind: 'notebook',
      targetId: hidden.id,
      subjectKind: 'member',
      subjectId: bob.id,
      allow: '0',
      deny: bits(P.VIEW_NOTEBOOKS),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect((await tree(bob, hidden.id)).status).toBe(404);
    expect((await tree(carol, hidden.id)).status).toBe(200);
    const list = await t.http.get(`/api/spaces/${teamSpace}/notebooks`).set(bob.auth);
    expect(list.body.map((n: { id: string }) => n.id)).toEqual([open.id]);
    const page = (
      await t.http
        .post('/api/pages')
        .set(alice.auth)
        .send({ id: uuid(), categoryId: hidden.catId, title: 'Secret', position: 'a0' })
    ).body;
    expect((await t.http.get(`/api/pages/${page.id}`).set(bob.auth)).status).toBe(404);
    expect((await content(bob, page.id, 'x')).status).toBe(404);
    expect(
      (
        await t.http
          .get('/api/export/markdown')
          .set(bob.auth)
          .query({ scope: 'notebook', id: hidden.id })
      ).status,
    ).toBe(404);

    // sync leaves it out and says so
    const sync = (await changes(bob, { [teamSpace]: 0 })).body.spaces[teamSpace];
    expect(sync.notebooks.map((n: { id: string }) => n.id)).toEqual([open.id]);
    expect(sync.pages).toEqual([]);
    expect(sync.hiddenNotebooks).toEqual([hidden.id]);

    // allowing EDIT_PAGES on the open one for @everyone lets plain viewers write there
    const openPage = (
      await t.http
        .post('/api/pages')
        .set(alice.auth)
        .send({ id: uuid(), categoryId: open.catId, title: 'Open', position: 'a0' })
    ).body;
    expect((await content(carol, openPage.id, 'before')).status).toBe(403);
    expect(
      (
        await setOverwrite(alice, {
          targetKind: 'notebook',
          targetId: open.id,
          subjectKind: 'role',
          subjectId: everyone.id,
          allow: bits(P.EDIT_PAGES),
          deny: '0',
        })
      ).status,
    ).toBe(200);
    expect((await content(carol, openPage.id, 'after')).status).toBe(200);

    // overwrites on a personal notebook make no sense
    const mine = (await builders(t, alice).notebook('Mine')).id;
    expect(
      (
        await setOverwrite(alice, {
          targetKind: 'notebook',
          targetId: mine,
          subjectKind: 'member',
          subjectId: bob.id,
          allow: '0',
          deny: bits(P.VIEW_NOTEBOOKS),
        })
      ).status,
    ).toBe(422);
  });

  it('only somebody with MANAGE_NOTEBOOKS may set them, and cannot grant what they lack', async () => {
    const nb = await teamNotebook(alice);
    const body = {
      targetKind: 'notebook',
      targetId: nb.id,
      subjectKind: 'member',
      subjectId: carol.id,
      allow: '0',
      deny: bits(P.VIEW_NOTEBOOKS),
    };
    expect((await setOverwrite(bob, body)).status).toBe(403);
    expect((await setOverwrite(dave, body)).status).toBe(404);
    await roleWith('manager', P.MANAGE_NOTEBOOKS, [bob]);
    expect((await setOverwrite(bob, body)).status).toBe(200);
    expect(
      (
        await setOverwrite(bob, {
          ...body,
          subjectId: carol.id,
          allow: bits(P.SHARE_NOTEBOOKS),
          deny: '0',
        })
      ).status,
    ).toBe(403); // bob lacks it
  });
});

// ------------------------------------------------------------------ 2. direct shares

describe('direct shares', () => {
  it('a read recipient reads, an edit recipient edits, and the owner pays for it', async () => {
    const { nb, page } = await fixture(alice, 'original');
    expect((await tree(bob, nb.id)).status).toBe(404);

    const s = await share(alice, nb.id, bob, 'read');
    const tr = await tree(bob, nb.id);
    expect(tr.status).toBe(200);
    expect(tr.body.pages.map((p: { id: string }) => p.id)).toEqual([page.id]);
    expect(
      JSON.stringify((await t.http.get(`/api/pages/${page.id}`).set(bob.auth)).body.content),
    ).toContain('original');
    expect((await content(bob, page.id, 'nope', 1)).status).toBe(403);
    expect(
      (await t.http.patch(`/api/notebooks/${nb.id}`).set(bob.auth).send({ name: 'mine now' }))
        .status,
    ).toBe(403);
    expect((await t.http.delete(`/api/notebooks/${nb.id}`).set(bob.auth)).status).toBe(403);
    expect((await t.http.get(`/api/notebooks/${nb.id}/shares`).set(bob.auth)).status).toBe(403); // cannot pass it on

    await share(alice, nb.id, bob, 'edit');
    const ownerBefore = await usedBytes(t, alice.id);
    const bobBefore = await usedBytes(t, bob.id);
    const big = 'x'.repeat(5000);
    expect((await content(bob, page.id, big, 1)).status).toBe(200);
    expect(await usedBytes(t, alice.id)).toBeGreaterThan(ownerBefore + 4000);
    expect(await usedBytes(t, bob.id)).toBe(bobBefore);
    // an editor can write and delete pages, but still cannot rename or delete the notebook
    expect(
      (
        await t.http.post('/api/pages').set(bob.auth).send({
          id: uuid(),
          categoryId: tr.body.categories[0].id,
          title: 'By Bob',
          position: 'a9',
        })
      ).status,
    ).toBe(201);
    expect(
      (await t.http.patch(`/api/notebooks/${nb.id}`).set(bob.auth).send({ name: 'mine now' }))
        .status,
    ).toBe(403);

    // removing the share ends everything at once
    await t.http.delete(`/api/notebooks/${nb.id}/shares/${s.id}`).set(alice.auth).expect(204);
    expect((await tree(bob, nb.id)).status).toBe(404);
    expect((await content(bob, page.id, 'again', 2)).status).toBe(404);
    expect((await t.http.get(`/api/pages/${page.id}`).set(bob.auth)).status).toBe(404);
  });

  it('shows up in sync under its own key and is revoked there when the share ends', async () => {
    const { nb, page } = await fixture(alice);
    const key = `shared:${nb.id}`;
    const s = await share(alice, nb.id, bob, 'edit');

    const first = (await changes(bob, {})).body;
    expect(first.sharedNotebooks).toMatchObject([
      { notebookId: nb.id, name: 'Plans', access: 'edit', ownerName: 'Test', viaLink: false },
    ]);
    expect(first.spaces[key].notebooks.map((n: { id: string }) => n.id)).toEqual([nb.id]);
    expect(first.spaces[key].pages.map((p: { id: string }) => p.id)).toEqual([page.id]);
    const cursor = first.spaces[key].cursor;

    // nothing else of the owner's leaks in
    await builders(t, alice).notebook('Private');
    const second = (await changes(bob, { [key]: cursor })).body;
    expect(second.spaces[key].notebooks).toEqual([]);
    expect(Object.keys(second.spaces)).toEqual([key]);

    const list = await t.http.get('/api/shared-with-me').set(bob.auth);
    expect(list.body).toHaveLength(1);

    await t.http.delete(`/api/notebooks/${nb.id}/shares/${s.id}`).set(alice.auth).expect(204);
    const gone = (await changes(bob, { [key]: cursor })).body;
    expect(gone.revokedSpaces).toEqual([key]);
    expect(gone.sharedNotebooks).toEqual([]);
    expect(gone.spaces[key]).toBeUndefined();
  });

  it('trashing the notebook also takes it away; the recipient can leave', async () => {
    const { nb } = await fixture(alice);
    await share(alice, nb.id, bob, 'read');
    await share(alice, nb.id, carol, 'read');
    await t.http.delete(`/api/notebooks/${nb.id}`).set(alice.auth).expect(204);
    expect((await changes(bob, { [`shared:${nb.id}`]: 0 })).body.revokedSpaces).toEqual([
      `shared:${nb.id}`,
    ]);
    await t.http.post(`/api/notebooks/${nb.id}/restore`).set(alice.auth).expect(200);
    await t.http.delete(`/api/shared-with-me/${nb.id}`).set(carol.auth).expect(204);
    expect((await tree(carol, nb.id)).status).toBe(404);
    expect((await tree(bob, nb.id)).status).toBe(200);
  });

  it('search covers shared notebooks, and only those', async () => {
    const { nb } = await fixture(alice, 'zebrafish habitat');
    await fixture(alice, 'zebrafish elsewhere');
    expect((await t.http.get('/api/search').set(bob.auth).query({ q: 'zebrafish' })).body).toEqual(
      [],
    );
    await share(alice, nb.id, bob, 'read');
    const hits = (await t.http.get('/api/search').set(bob.auth).query({ q: 'zebrafish' })).body;
    expect(hits.map((h: { notebookId: string }) => h.notebookId)).toEqual([nb.id]);
  });

  it('files: the recipient sees what the notebook uses, uploads for it, and nothing else of the owner', async () => {
    const { nb, page } = await fixture(alice);
    const used = uuid();
    const other = uuid();
    const up = (who: Account, id: string, extra: object = {}) => {
      const req = t.http.post('/api/media').set(who.auth).field('id', id);
      for (const [k, v] of Object.entries(extra)) req.field(k, String(v));
      return png().then((buf) => req.attach('file', buf, 'a.png'));
    };
    expect((await up(alice, used)).status).toBe(201);
    expect((await up(alice, other)).status).toBe(201);
    const fig = (id: string) => ({
      type: 'imageFigure',
      attrs: { mediaId: id, alt: 'a', caption: '', width: null, align: 'center' },
    });
    expect(
      (
        await t.http
          .post(`/api/pages/${page.id}/snapshots/replace`)
          .set(alice.auth)
          .send({ content: { type: 'doc', content: [fig(used)] }, baseVersion: 1 })
      ).status,
    ).toBe(200);

    const fetch = (who: Account, id: string) => t.http.get(`/api/media/${id}`).set(who.auth);
    expect((await fetch(bob, used)).status).toBe(404);
    await share(alice, nb.id, bob, 'edit');
    expect((await fetch(bob, used)).status).toBe(200);
    expect((await fetch(bob, other)).status).toBe(404); // in the owner's space, not in the notebook

    // the editor uploads into the notebook's space, which the owner pays for
    const mine = uuid();
    const ownerBefore = await usedBytes(t, alice.id);
    const bobBefore = await usedBytes(t, bob.id);
    expect((await up(bob, mine, { notebookId: nb.id })).status).toBe(201);
    expect(await usedBytes(t, alice.id)).toBeGreaterThan(ownerBefore);
    expect(await usedBytes(t, bob.id)).toBe(bobBefore);
    expect((await fetch(bob, mine)).status).toBe(200);
    // a read-only recipient cannot upload into it
    await share(alice, nb.id, bob, 'read');
    expect((await up(bob, uuid(), { notebookId: nb.id })).status).toBe(403);
  });

  it('only teammates can be picked by id; an address works for anybody and answers the same either way', async () => {
    const { nb } = await fixture(alice);
    expect((await put(alice, nb.id, { userId: dave.id, access: 'read' })).status).toBe(404); // shares no team with the owner
    expect((await put(alice, nb.id, { userId: alice.id, access: 'read' })).status).toBe(422);
    expect((await put(alice, nb.id, {})).status).toBe(400);

    const known = await put(alice, nb.id, { email: dave.email, access: 'read' });
    const stranger = uniqueEmail('nobody');
    const unknown = await put(alice, nb.id, { email: stranger, access: 'read' });
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(known.body).toEqual({ ok: true });
    expect((await tree(dave, nb.id)).status).toBe(200);
    expect(t.mail.last('share', dave.email)?.share).toMatchObject({
      notebook: 'Plans',
      access: 'read',
      hasAccount: true,
    });
    expect(t.mail.last('share', stranger)?.share?.hasAccount).toBe(false);
  });

  it('an address with no account waits and starts working when somebody verifies it', async () => {
    const { nb } = await fixture(alice);
    const email = uniqueEmail('newcomer');
    await put(alice, nb.id, { email, access: 'edit' }).expect(200);
    const listed = (await t.http.get(`/api/notebooks/${nb.id}/shares`).set(alice.auth)).body;
    expect(listed.pending).toMatchObject([{ email, access: 'edit' }]);

    // registering is not enough: the address must be verified
    const reg = await t.http
      .post('/api/auth/register')
      .send({ email, password: GOOD_PASSWORD, displayName: 'New' });
    expect(reg.status).toBe(201);
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    expect((await t.http.get(`/api/notebooks/${nb.id}/tree`).set(auth)).status).toBe(404);
    const token = t.mail.last('verify', email)!.token;
    await t.http.post('/api/auth/verify-email').send({ token }).expect(200);
    // verifying applies what waited
    const login = await t.http.post('/api/auth/login').send({ email, password: GOOD_PASSWORD });
    const authed = { Authorization: `Bearer ${login.body.accessToken}` };
    expect((await t.http.get(`/api/notebooks/${nb.id}/tree`).set(authed)).status).toBe(200);
    expect(
      (await t.http.get(`/api/notebooks/${nb.id}/shares`).set(alice.auth)).body.pending,
    ).toEqual([]);
  });

  it('team notebooks cannot be shared with people (roles decide), and nobody else can share yours', async () => {
    const nb = await teamNotebook(alice);
    expect((await put(alice, nb.id, { userId: bob.id, access: 'read' })).status).toBe(422);
    const mine = (await fixture(alice)).nb;
    expect((await put(dave, mine.id, { userId: bob.id, access: 'read' })).status).toBe(404);
  });
});

// ------------------------------------------------------------------ 3-5. links

describe('share links', () => {
  it('anonymous read works and shows nothing about people', async () => {
    const { nb, page } = await fixture(alice, 'public words');
    const { token, url } = await link(alice, nb.id);
    expect(url).toMatch(new RegExp(`/s/${token}$`));
    const res = await resolve(token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.notebook).toMatchObject({ id: nb.id, name: 'Plans' });
    expect(res.body.access).toBe('read');
    expect(res.body.pages.map((p: { id: string }) => p.id)).toEqual([page.id]);
    expect(res.body.ownerName).toBeNull();
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(alice.id);
    expect(text).not.toContain(alice.email);
    expect(text).not.toContain('spaceId');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['cache-control']).toBe('no-store');

    const p = await t.http.get(`/api/links/${token}/pages/${page.id}`);
    expect(p.status).toBe(200);
    expect(JSON.stringify(p.body.content)).toContain('public words');
    expect(JSON.stringify(p.body)).not.toContain(alice.id);

    // the stored token is a hash
    const row = await t.prisma.shareLink.findFirstOrThrow({ where: { notebookId: nb.id } });
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenHash).toHaveLength(64);
  });

  it('showAuthors decides whether the owner is named', async () => {
    const { nb } = await fixture(alice);
    const named = await link(alice, nb.id, { access: 'read', showAuthors: true });
    expect((await resolve(named.token)).body.ownerName).toBe('Test');
    await t.http
      .patch(`/api/links/${named.id}`)
      .set(alice.auth)
      .send({ showAuthors: false })
      .expect(200);
    expect((await resolve(named.token)).body.ownerName).toBeNull();
  });

  it('edit links need a login: anonymous join is 401, and nothing in the public API writes', async () => {
    const { nb, page } = await fixture(alice);
    const { token } = await link(alice, nb.id, { access: 'edit' });
    expect((await resolve(token)).body.access).toBe('edit'); // reading is fine
    expect((await t.http.post('/api/links/join').send({ token })).status).toBe(401);
    expect(
      (
        await t.http
          .post(`/api/pages/${page.id}/snapshots/replace`)
          .send({ content: para('x'), baseVersion: 1 })
      ).status,
    ).toBe(401);

    // a read link cannot be joined
    const read = await link(alice, nb.id, { access: 'read' });
    expect(
      (await t.http.post('/api/links/join').set(bob.auth).send({ token: read.token })).status,
    ).toBe(422);
  });

  it('expired, revoked and unknown tokens all answer the same', async () => {
    const { nb, page } = await fixture(alice);
    const expired = await link(alice, nb.id, { access: 'read', expiresInDays: 1 });
    const revoked = await link(alice, nb.id);
    await t.prisma.shareLink.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await t.http.delete(`/api/links/${revoked.id}`).set(alice.auth).expect(204);
    const unknown = 'A'.repeat(43);

    const seen = [];
    for (const tok of [expired.token, revoked.token, unknown]) {
      const a = await resolve(tok);
      const b = await t.http.get(`/api/links/${tok}/pages/${page.id}`);
      const c = await t.http.get(`/api/links/${tok}/search`).query({ q: 'hello' });
      seen.push([a.status, a.body, b.status, b.body, c.status, c.body]);
    }
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).toEqual(seen[2]);
    expect(seen[0]![0]).toBe(404);
  });

  it('a trashed notebook closes its links until it comes back', async () => {
    const { nb } = await fixture(alice);
    const { token } = await link(alice, nb.id);
    await t.http.delete(`/api/notebooks/${nb.id}`).set(alice.auth).expect(204);
    expect((await resolve(token)).status).toBe(404);
    await t.http.post(`/api/notebooks/${nb.id}/restore`).set(alice.auth).expect(200);
    expect((await resolve(token)).status).toBe(200);
  });

  it('a password is asked for, checked, throttled after five wrong tries, and traded for a session', async () => {
    const { nb, page } = await fixture(alice);
    const { token, id } = await link(alice, nb.id, { access: 'read', password: 'sesame-open' });
    expect(
      (await t.http.get(`/api/notebooks/${nb.id}/links`).set(alice.auth)).body[0],
    ).toMatchObject({ id, hasPassword: true });

    expect((await resolve(token)).status).toBe(401);
    expect((await t.http.get(`/api/links/${token}/pages/${page.id}`)).status).toBe(401); // no session, no password
    for (let i = 0; i < 5; i++) expect((await resolve(token, `wrong-${i}`)).status).toBe(403);
    expect((await resolve(token, 'sesame-open')).status).toBe(429); // blocked even for the right one
    expect(PASSWORD_WINDOW_MS).toBeGreaterThan(0);
  });

  it('the right password gives a session that opens the pages and the search', async () => {
    const { nb, page } = await fixture(alice, 'needle in a haystack');
    const { token } = await link(alice, nb.id, { access: 'read', password: 'sesame-open' });
    const ok = await resolve(token, 'sesame-open');
    expect(ok.status).toBe(200);
    const s = ok.body.session as string;
    expect((await t.http.get(`/api/links/${token}/pages/${page.id}`).query({ s })).status).toBe(
      200,
    );
    expect(
      (await t.http.get(`/api/links/${token}/pages/${page.id}`).query({ s: 'garbage' })).status,
    ).toBe(401);
    const hits = await t.http.get(`/api/links/${token}/search`).query({ q: 'needle', s });
    expect(hits.body.map((h: { pageId: string }) => h.pageId)).toEqual([page.id]);

    // a session for one link is worth nothing for another
    const other = await fixture(alice);
    const otherLink = await link(alice, other.nb.id, { access: 'read', password: 'another-one' });
    expect(
      (await t.http.get(`/api/links/${otherLink.token}/pages/${other.page.id}`).query({ s }))
        .status,
    ).toBe(401);

    // removing the password opens the link to everybody
    await t.http
      .patch(
        `/api/links/${(await t.prisma.shareLink.findFirstOrThrow({ where: { notebookId: nb.id } })).id}`,
      )
      .set(alice.auth)
      .send({ password: null })
      .expect(200);
    expect((await resolve(token)).status).toBe(200);
  });

  it('a link opens its own notebook only: no other notebook, trashed page or file', async () => {
    const a = await fixture(alice, 'in a');
    const b = await fixture(alice, 'in b');
    const { token } = await link(alice, a.nb.id);
    const own = await t.http.get(`/api/links/${token}/pages/${a.page.id}`);
    const foreign = await t.http.get(`/api/links/${token}/pages/${b.page.id}`);
    const missing = await t.http.get(`/api/links/${token}/pages/${uuid()}`);
    expect(own.status).toBe(200);
    expect([foreign.status, foreign.body]).toEqual([missing.status, missing.body]);

    await t.http.delete(`/api/pages/${a.page.id}`).set(alice.auth).expect(204);
    expect((await t.http.get(`/api/links/${token}/pages/${a.page.id}`)).status).toBe(404);

    expect((await t.http.get(`/api/links/${token}/search`).query({ q: 'in' })).body).toEqual([]); // b's text is not here
  });

  it('serves files the notebook uses, and no other file of the owner', async () => {
    const { nb, page } = await fixture(alice);
    const used = uuid();
    const other = uuid();
    for (const id of [used, other])
      expect(
        (
          await t.http
            .post('/api/media')
            .set(alice.auth)
            .field('id', id)
            .attach('file', await png(), 'a.png')
        ).status,
      ).toBe(201);
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'imageFigure',
          attrs: { mediaId: used, alt: 'a', caption: '', width: null, align: 'center' },
        },
      ],
    };
    expect(
      (
        await t.http
          .post(`/api/pages/${page.id}/snapshots/replace`)
          .set(alice.auth)
          .send({ content: doc, baseVersion: 1 })
      ).status,
    ).toBe(200);

    const { token } = await link(alice, nb.id);
    const file = await t.http.get(`/api/links/${token}/media/${used}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('image/png');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect((await t.http.get(`/api/links/${token}/media/${other}`)).status).toBe(404);
    expect((await t.http.get(`/api/media/${used}`)).status).toBe(401);
    await t.http
      .delete(
        `/api/links/${(await t.prisma.shareLink.findFirstOrThrow({ where: { notebookId: nb.id } })).id}`,
      )
      .set(alice.auth)
      .expect(204);
    expect((await t.http.get(`/api/links/${token}/media/${used}`)).status).toBe(404);
  });

  it('revoking an edit link ends the edit access of a person who used it, mid-session', async () => {
    const { nb, page } = await fixture(alice);
    const { token, id } = await link(alice, nb.id, { access: 'edit' });
    const joined = await t.http.post('/api/links/join').set(bob.auth).send({ token });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body).toEqual({ notebookId: nb.id, access: 'edit' });

    expect((await changes(bob, {})).body.sharedNotebooks).toMatchObject([
      { notebookId: nb.id, access: 'edit', viaLink: true },
    ]);
    expect((await content(bob, page.id, 'written through the link', 1)).status).toBe(200);

    await t.http.delete(`/api/links/${id}`).set(alice.auth).expect(204);
    expect((await content(bob, page.id, 'one more', 2)).status).toBe(404);
    expect((await tree(bob, nb.id)).status).toBe(404);
    expect((await t.http.post('/api/links/join').set(bob.auth).send({ token })).status).toBe(404);
  });

  it('a person who already has direct edit keeps it when the link they used is revoked', async () => {
    const { nb } = await fixture(alice);
    await share(alice, nb.id, bob, 'edit');
    const { token, id } = await link(alice, nb.id, { access: 'edit' });
    await t.http.post('/api/links/join').set(bob.auth).send({ token }).expect(200);
    await t.http.delete(`/api/links/${id}`).set(alice.auth).expect(204);
    expect((await tree(bob, nb.id)).status).toBe(200);
  });

  it('only people who may share manage links; team notebooks only get read links, when the team allows it', async () => {
    const { nb } = await fixture(alice);
    expect(
      (await t.http.post(`/api/notebooks/${nb.id}/links`).set(bob.auth).send({ access: 'read' }))
        .status,
    ).toBe(404);
    await share(alice, nb.id, bob, 'edit');
    expect(
      (await t.http.post(`/api/notebooks/${nb.id}/links`).set(bob.auth).send({ access: 'read' }))
        .status,
    ).toBe(403);
    expect((await t.http.get(`/api/notebooks/${nb.id}/links`).set(bob.auth)).status).toBe(403);

    const team = await teamNotebook(alice);
    const post = (who: Account, body: object) =>
      t.http.post(`/api/notebooks/${team.id}/links`).set(who.auth).send(body);
    expect((await post(alice, { access: 'read' })).status).toBe(403); // the team has not allowed public links
    expect(
      (await t.http.patch(`/api/teams/${teamId}`).set(alice.auth).send({ allowPublicLinks: true }))
        .status,
    ).toBe(200);
    expect((await post(alice, { access: 'edit' })).status).toBe(422);
    expect((await post(bob, { access: 'read' })).status).toBe(403); // bob cannot share
    await roleWith('sharer', P.SHARE_NOTEBOOKS, [bob]);
    const made = await post(bob, { access: 'read' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await resolve(made.body.token)).status).toBe(200);

    // switching the setting off closes what was made
    await t.http
      .patch(`/api/teams/${teamId}`)
      .set(alice.auth)
      .send({ allowPublicLinks: false })
      .expect(200);
    expect((await resolve(made.body.token)).status).toBe(404);

    const audit = await t.prisma.auditLog.findMany({
      where: { teamId, action: 'notebook.link.create' },
    });
    expect(audit).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ 6. moving

describe('moving a notebook', () => {
  const move = (who: Account, id: string, spaceId: string) =>
    t.http.post(`/api/notebooks/${id}/move`).set(who.auth).send({ spaceId });

  it('personal -> team re-attributes pages and files, moves the quota, and ends shares and links', async () => {
    const { nb, page } = await fixture(alice, 'x'.repeat(3000));
    const img = uuid();
    await t.http
      .post('/api/media')
      .set(alice.auth)
      .field('id', img)
      .attach('file', await png(), 'a.png')
      .expect(201);
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'imageFigure',
          attrs: { mediaId: img, alt: 'a', caption: '', width: null, align: 'center' },
        },
      ],
    };
    await t.http
      .post(`/api/pages/${page.id}/snapshots/replace`)
      .set(alice.auth)
      .send({ content: doc, baseVersion: 1 })
      .expect(200);
    await share(alice, nb.id, bob, 'edit');
    const lk = await link(alice, nb.id);
    const mine = await personalSpaceId(t, alice.id);

    const usedBefore = await usedBytes(t, alice.id);
    const teamBefore = Number(
      (await t.prisma.space.findUniqueOrThrow({ where: { id: teamSpace } })).storageUsedBytes,
    );
    expect(usedBefore).toBeGreaterThan(0);

    const res = await move(alice, nb.id, teamSpace);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.spaceId).toBe(teamSpace);

    for (const row of [
      await t.prisma.page.findFirstOrThrow({ where: { notebookId: nb.id } }),
      await t.prisma.category.findFirstOrThrow({ where: { notebookId: nb.id } }),
      await t.prisma.media.findUniqueOrThrow({ where: { id: img } }),
    ])
      expect(row.spaceId).toBe(teamSpace);
    expect(await usedBytes(t, alice.id)).toBe(0);
    expect(
      Number(
        (await t.prisma.space.findUniqueOrThrow({ where: { id: teamSpace } })).storageUsedBytes,
      ),
    ).toBe(teamBefore + usedBefore);

    // shares and links did not follow
    expect(await t.prisma.notebookShare.count({ where: { notebookId: nb.id } })).toBe(0);
    expect((await resolve(lk.token)).status).toBe(404);
    expect((await tree(bob, nb.id)).status).toBe(200); // bob is in the team now, so he sees it as a team notebook
    expect((await changes(bob, { [`shared:${nb.id}`]: 0 })).body.revokedSpaces).toEqual([
      `shared:${nb.id}`,
    ]);

    // the space it left is told
    const left = (await changes(alice, { [mine]: 0 })).body.spaces[mine];
    expect(left.movedOut).toEqual([nb.id]);
    expect(
      (await changes(alice, { [teamSpace]: 0 })).body.spaces[teamSpace].notebooks.map(
        (n: { id: string }) => n.id,
      ),
    ).toContain(nb.id);
    expect((await t.http.get(`/api/pages/${page.id}`).set(alice.auth)).status).toBe(200); // alice is still the team owner
    expect(
      (await t.prisma.auditLog.findMany({ where: { teamId, action: 'notebook.move' } })).length,
    ).toBeGreaterThan(0);
  });

  it('is refused without the right to create in the target, or manage the source', async () => {
    const { nb } = await fixture(bob);
    expect((await move(bob, nb.id, teamSpace)).status).toBe(403); // can see the team, cannot create notebooks there
    expect((await move(dave, nb.id, teamSpace)).status).toBe(404); // not hers
    expect((await move(bob, nb.id, await personalSpaceId(t, carol.id))).status).toBe(404); // somebody else's space
    const teamNb = await teamNotebook(alice);
    expect((await move(bob, teamNb.id, await personalSpaceId(t, bob.id))).status).toBe(403); // cannot manage the team notebook
    expect((await move(dave, teamNb.id, await personalSpaceId(t, dave.id))).status).toBe(404);
    expect((await tree(bob, nb.id)).status).toBe(200); // nothing happened
  });

  it('is refused, all or nothing, when the target has no room', async () => {
    const { nb, page } = await fixture(alice, 'y'.repeat(4000));
    await t.prisma.quotaOverride.create({
      data: { id: uuid(), scope: 'team', scopeId: teamId, storageBytes: 500n, updatedBy: alice.id },
    });
    const before = await usedBytes(t, alice.id);
    const res = await move(alice, nb.id, teamSpace);
    expect(res.status).toBe(413);
    expect(res.body.code ?? res.body.message).toMatch(/quota/);
    expect((await t.prisma.page.findUniqueOrThrow({ where: { id: page.id } })).spaceId).toBe(
      await personalSpaceId(t, alice.id),
    );
    expect(await usedBytes(t, alice.id)).toBe(before);
    expect(await t.prisma.notebookMove.count({ where: { notebookId: nb.id } })).toBe(0);
  });

  it('team -> personal and back keep the numbers right; a file used by two notebooks blocks the move', async () => {
    const { nb, page } = await fixture(alice, 'z'.repeat(1000));
    const mine = await personalSpaceId(t, alice.id);
    const before = await usedBytes(t, alice.id);
    await move(alice, nb.id, teamSpace).expect(200);
    await move(alice, nb.id, mine).expect(200);
    expect(await usedBytes(t, alice.id)).toBe(before);
    expect((await changes(alice, { [teamSpace]: 0 })).body.spaces[teamSpace].movedOut).toEqual([
      nb.id,
    ]);

    const img = uuid();
    await t.http
      .post('/api/media')
      .set(alice.auth)
      .field('id', img)
      .attach('file', await png(), 'a.png')
      .expect(201);
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'imageFigure',
          attrs: { mediaId: img, alt: 'a', caption: '', width: null, align: 'center' },
        },
      ],
    };
    const otherNb = await fixture(alice);
    await t.http
      .post(`/api/pages/${page.id}/snapshots/replace`)
      .set(alice.auth)
      .send({ content: doc, baseVersion: 1 })
      .expect(200);
    await t.http
      .post(`/api/pages/${otherNb.page.id}/snapshots/replace`)
      .set(alice.auth)
      .send({ content: doc, baseVersion: 1 })
      .expect(200);
    const res = await move(alice, nb.id, teamSpace);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('media_shared_with_other_notebook');
  });
});

// ------------------------------------------------------------------ what the web app asks for

describe('notebook permissions for the web app', () => {
  it('lists team and shared notebooks with what the person may do there, and leaves personal ones out', async () => {
    const team = await teamNotebook(alice);
    const mine = (await fixture(alice)).nb;
    const shared = (await fixture(carol)).nb;
    await share(carol, shared.id, bob, 'read');
    await roleWith('editor', P.EDIT_PAGES, [bob]);

    const res = await t.http.get('/api/notebook-permissions').set(bob.auth);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([team.id, shared.id].sort());
    const perms = (id: string) => BigInt(res.body[id]);
    expect(perms(team.id) & P.EDIT_PAGES).toBe(P.EDIT_PAGES);
    expect(perms(team.id) & P.MANAGE_NOTEBOOKS).toBe(0n);
    expect(perms(shared.id)).toBe(P.VIEW_NOTEBOOKS);
    expect(res.body[mine.id]).toBeUndefined();

    // hidden by an overwrite: not listed; trashed: still listed (it can be restored)
    await t.http
      .put('/api/overwrites')
      .set(alice.auth)
      .send({
        targetKind: 'notebook',
        targetId: team.id,
        subjectKind: 'member',
        subjectId: bob.id,
        allow: '0',
        deny: bits(P.VIEW_NOTEBOOKS),
      })
      .expect(200);
    expect(Object.keys((await t.http.get('/api/notebook-permissions').set(bob.auth)).body)).toEqual(
      [shared.id],
    );
    const trashed = await teamNotebook(alice);
    await t.http.delete(`/api/notebooks/${trashed.id}`).set(alice.auth).expect(204);
    expect(
      Object.keys((await t.http.get('/api/notebook-permissions').set(carol.auth)).body),
    ).toContain(trashed.id);
  });
});
