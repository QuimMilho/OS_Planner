import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChangeSeqService } from '../src/prisma/change-seq.service.js';
import { TeamsService } from '../src/teams/teams.service.js';
import { createTestApp, type TestApp } from './app.js';
import { personalSpaceId, signup, uuid, type Account } from './helpers.js';

let t: TestApp;
let owner: Account;
let member: Account;
let teamId: string;
let teamSpace: string;
let mine: string; // owner personal space

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.prisma.team.deleteMany();
  await t.prisma.user.deleteMany();
  owner = await signup(t);
  member = await signup(t);
  const team = await t.app
    .get(TeamsService)
    .adminCreate(
      { name: 'Sync team', ownerEmail: owner.email, isPublic: false, joinPolicy: 'request' },
      owner.id,
    );
  teamId = team.id;
  teamSpace = (await t.prisma.team.findUniqueOrThrow({ where: { id: teamId } })).spaceId;
  mine = await personalSpaceId(t, owner.id);
  await t.prisma.teamMember.create({ data: { teamId, userId: member.id } });
});

const changes = (who: Account, cursors: Record<string, number>) =>
  t.http
    .get('/api/sync/changes')
    .query({ cursors: JSON.stringify(cursors) })
    .set(who.auth);
const notebook = (who: Account, spaceId?: string, name = 'N') =>
  t.http
    .post('/api/notebooks')
    .set(who.auth)
    .send({ id: uuid(), ...(spaceId ? { spaceId } : {}), name, position: 'a0' });

describe('sync by space', () => {
  it('advances each space on its own and only delivers what changed in it', async () => {
    const first = await changes(owner, { [mine]: 0, [teamSpace]: 0 });
    expect(first.status).toBe(200);
    expect(first.body.revokedSpaces).toEqual([]);
    expect(first.body.spaces[mine]).toMatchObject({ cursor: 0, hasMore: false, notebooks: [] });
    expect(first.body.spaces[teamSpace]).toMatchObject({ cursor: 0, notebooks: [] });

    const a = (await notebook(owner, teamSpace, 'Team A')).body;
    const b = (await notebook(owner, teamSpace, 'Team B')).body;
    const c = (await notebook(owner, undefined, 'Mine')).body;

    const second = (await changes(owner, { [mine]: 0, [teamSpace]: 0 })).body;
    expect(second.spaces[teamSpace].notebooks.map((n: { id: string }) => n.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(second.spaces[teamSpace].cursor).toBe(2);
    expect(second.spaces[mine].notebooks.map((n: { id: string }) => n.id)).toEqual([c.id]);
    expect(second.spaces[mine].cursor).toBe(1);
    expect(
      second.spaces[teamSpace].notebooks.every((n: { spaceId: string }) => n.spaceId === teamSpace),
    ).toBe(true);

    // a change in the team space moves only the team cursor
    await t.http.patch(`/api/notebooks/${a.id}`).set(owner.auth).send({ name: 'Team A2' });
    const third = (await changes(owner, { [mine]: 1, [teamSpace]: 2 })).body;
    expect(third.spaces[mine]).toMatchObject({ cursor: 1, notebooks: [] });
    expect(third.spaces[teamSpace]).toMatchObject({ cursor: 3 });
    expect(third.spaces[teamSpace].notebooks.map((n: { name: string }) => n.name)).toEqual([
      'Team A2',
    ]);
  });

  it('delivers a team space to its members, with the same rows', async () => {
    const nb = (await notebook(owner, teamSpace, 'Shared')).body;
    const seen = (await changes(member, { [teamSpace]: 0 })).body;
    expect(seen.spaces[teamSpace].notebooks.map((n: { id: string }) => n.id)).toEqual([nb.id]);
  });

  it('lists a space in revokedSpaces once the person loses it, and not again once they stop asking', async () => {
    await notebook(owner, teamSpace);
    expect((await changes(member, { [teamSpace]: 0 })).body.spaces[teamSpace]).toBeDefined();

    await t.http.delete(`/api/teams/${teamId}/members/${member.id}`).set(owner.auth);
    const after = (await changes(member, { [teamSpace]: 1 })).body;
    expect(after.revokedSpaces).toEqual([teamSpace]);
    expect(after.spaces).toEqual({});

    // the client purged it and no longer sends the cursor
    expect(
      (await changes(member, { [await personalSpaceId(t, member.id)]: 0 })).body.revokedSpaces,
    ).toEqual([]);
  });

  it('revokes the spaces of a deleted team and of a deleted project at once', async () => {
    const project = (
      await t.http.post(`/api/teams/${teamId}/projects`).set(owner.auth).send({ name: 'P' })
    ).body;
    expect(
      (await changes(owner, { [project.spaceId]: 0, [teamSpace]: 0 })).body.revokedSpaces,
    ).toEqual([]);

    await t.http.delete(`/api/projects/${project.id}`).set(owner.auth);
    expect(
      (await changes(owner, { [project.spaceId]: 0, [teamSpace]: 0 })).body.revokedSpaces,
    ).toEqual([project.spaceId]);

    await t.prisma.team.update({ where: { id: teamId }, data: { deletedAt: new Date() } });
    expect((await changes(owner, { [teamSpace]: 0 })).body.revokedSpaces).toEqual([teamSpace]);
    expect((await changes(member, { [teamSpace]: 0 })).body.revokedSpaces).toEqual([teamSpace]);
  });

  it('treats a space that does not exist, or that belongs to somebody else, as revoked (no hint which)', async () => {
    const strangers = await personalSpaceId(t, member.id);
    const res = (await changes(owner, { [uuid()]: 0, [strangers]: 0 })).body;
    expect(res.revokedSpaces).toHaveLength(2);
    expect(res.revokedSpaces).toContain(strangers);
    expect(res.spaces).toEqual({});
  });

  it('still accepts the single `since` cursor of older clients (the personal space)', async () => {
    const nb = (await notebook(owner)).body;
    await notebook(owner, teamSpace, 'Not in the personal feed');
    const legacy = await t.http.get('/api/sync/changes').query({ since: 0 }).set(owner.auth);
    expect(legacy.status).toBe(200);
    expect(legacy.body.notebooks.map((n: { id: string }) => n.id)).toEqual([nb.id]);
    expect(legacy.body.cursor).toBe(1);
    expect(legacy.body.revokedSpaces).toEqual([]);
    expect((await t.http.get('/api/sync/changes').set(owner.auth)).body.cursor).toBe(1); // no cursor at all means from the start
  });

  it('rejects cursors that are not JSON, or not space ids', async () => {
    expect(
      (await t.http.get('/api/sync/changes').query({ cursors: '{nope' }).set(owner.auth)).status,
    ).toBe(400);
    expect(
      (
        await t.http
          .get('/api/sync/changes')
          .query({ cursors: JSON.stringify({ 'not-a-uuid': 0 }) })
          .set(owner.auth)
      ).status,
    ).toBe(400);
    expect(
      (
        await t.http
          .get('/api/sync/changes')
          .query({ cursors: JSON.stringify({ [mine]: -4 }) })
          .set(owner.auth)
      ).status,
    ).toBe(400);
  });

  it('numbers concurrent writes in one space without gaps and in order', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => notebook(owner, teamSpace, `N${i}`)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seqs = results.map((r) => r.body.seq as number).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const space = await t.prisma.space.findUniqueOrThrow({ where: { id: teamSpace } });
    expect(Number(space.changeSeq)).toBe(12);
    expect(
      (await changes(member, { [teamSpace]: 0 })).body.spaces[teamSpace].notebooks,
    ).toHaveLength(12);
  });

  it('does not make a write in one space wait for a write in another', async () => {
    const seq = t.app.get(ChangeSeqService);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));

    // a transaction that has taken the team space's lock and is slow to finish
    const slow = t.prisma.$transaction(async (tx) => {
      await seq.next(tx, teamSpace);
      locked();
      await gate;
    });
    await holding;

    const started = Date.now();
    const free = await notebook(owner); // personal space: must not wait
    expect(free.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(5000);

    // ...whereas a write in the locked space has to wait for it
    let finished = false;
    const waiting = notebook(owner, teamSpace).then((r) => ((finished = true), r));
    await new Promise((r) => setTimeout(r, 300));
    expect(finished).toBe(false);
    release();
    await slow;
    expect((await waiting).status).toBe(201);
  });

  it('mirrors the personal sequence to the user row for clients that still read it', async () => {
    await notebook(owner);
    await notebook(owner);
    expect(
      Number((await t.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).changeSeq),
    ).toBe(2);
    await notebook(owner, teamSpace);
    expect(
      Number((await t.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).changeSeq),
    ).toBe(2); // team writes are not personal
  });
});
