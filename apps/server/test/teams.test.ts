import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE,
  hasPermission,
  Permission,
  permissionsFromString,
  positionBetween,
} from '@os-planner/shared';
import { MaintenanceService } from '../src/media/maintenance.service.js';
import { QuotaService } from '../src/quota/quota.service.js';
import { createTestApp, GOOD_PASSWORD, uniqueEmail, type TestApp } from './app.js';
import { personalSpaceId, signup, uuid, para, type Account } from './helpers.js';

const ADMIN_EMAIL = `teams-admin${Date.now()}@example.com`;
const DAY = 24 * 60 * 60 * 1000;

let t: TestApp;
let saved: string | undefined;
let admin: Account;
let owner: Account;
let member: Account;
let outsider: Account;

beforeAll(async () => {
  saved = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  if (saved === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = saved;
});
beforeEach(async () => {
  await t.prisma.team.deleteMany();
  await t.prisma.quotaOverride.deleteMany();
  await t.prisma.user.deleteMany();
  admin = await signup(t, true, ADMIN_EMAIL);
  owner = await signup(t);
  member = await signup(t);
  outsider = await signup(t);
});

// ------------------------------------------------------------------ helpers

interface Team {
  id: string;
  spaceId: string;
  [k: string]: unknown;
}

const createTeam = async (ownerEmail: string, name = 'Rocket Team', extra: object = {}) => {
  const res = await t.http
    .post('/api/admin/teams')
    .set(admin.auth)
    .send({ name, ownerEmail, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as {
    id: string;
    slug: string;
    owner: { id: string } | null;
    pendingOwnerEmail: string | null;
    memberCount: number;
  };
};
const teamOf = async (id: string): Promise<Team> => {
  const row = await t.prisma.team.findUniqueOrThrow({ where: { id } });
  return { ...row, id: row.id, spaceId: row.spaceId };
};
const join = (teamId: string, who: Account) =>
  t.prisma.teamMember.create({ data: { teamId, userId: who.id } });
let lastPos: string | null = null;
const project = async (
  who: Account,
  teamId: string,
  name = 'Project',
  parentId: string | null = null,
) => {
  lastPos = positionBetween(lastPos, null);
  const res = await t.http
    .post(`/api/teams/${teamId}/projects`)
    .set(who.auth)
    .send({ name, parentId, position: lastPos });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; spaceId: string; parentId: string | null; isMember: boolean };
};
const projectMember = (projectId: string, who: Account) =>
  t.prisma.projectMember.create({ data: { projectId, userId: who.id } });

/** A team with an owner and one ordinary member. */
async function standardTeam() {
  const team = await createTeam(owner.email);
  await join(team.id, member);
  return team;
}

// ------------------------------------------------------------------ creating teams

describe('an admin creates a team', () => {
  it('with an existing owner: the owner is a member and holds every permission', async () => {
    const team = await createTeam(owner.email, 'Žluťoučký Kůň');
    expect(team).toMatchObject({
      memberCount: 1,
      pendingOwnerEmail: null,
      owner: { id: owner.id },
    });
    expect(team.slug).toBe('zlutoucky-kun');

    const row = await teamOf(team.id);
    expect(row.ownerId).toBe(owner.id);
    const everyone = await t.prisma.role.findFirstOrThrow({ where: { teamId: team.id, isEveryone: true } });
    expect(everyone).toMatchObject({ name: '@everyone', position: 0, projectId: null });
    expect(everyone.permissions).toBe(BigInt(DEFAULT_EVERYONE));
    const space = await t.prisma.space.findUniqueOrThrow({ where: { teamId: team.id } });
    expect(space).toMatchObject({ kind: 'team', id: row.spaceId });
    expect(await t.prisma.teamMember.count({ where: { teamId: team.id, userId: owner.id } })).toBe(
      1,
    );

    const me = await t.http.get(`/api/teams/${team.id}/me`).set(owner.auth);
    expect(me.status).toBe(200);
    expect(permissionsFromString(me.body.permissions)).toBe(ALL_PERMISSIONS);
    expect(me.body.isOwner).toBe(true);
  });

  it('with an unknown email: a pending owner and no members until that person signs up, verifies and signs in', async () => {
    const email = uniqueEmail('newcomer');
    const team = await createTeam(email, 'Waiting Room');
    expect(team).toMatchObject({ memberCount: 0, owner: null, pendingOwnerEmail: email });
    expect(await t.prisma.pendingOwner.count({ where: { teamId: team.id, email } })).toBe(1);
    expect(await t.prisma.teamMember.count({ where: { teamId: team.id } })).toBe(0);

    // Registering is not enough: anybody can type anybody's address. A verified address is.
    const reg = await t.http
      .post('/api/auth/register')
      .send({ email, password: GOOD_PASSWORD, displayName: 'Newcomer' });
    expect(reg.status).toBe(201);
    expect((await teamOf(team.id)).ownerId).toBeNull();
    expect(
      (await t.http.get('/api/teams').set({ Authorization: `Bearer ${reg.body.accessToken}` }))
        .body,
    ).toEqual([]);

    await t.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    const login = await t.http.post('/api/auth/login').send({ email, password: GOOD_PASSWORD });
    expect(login.status).toBe(200);

    const row = await teamOf(team.id);
    expect(row.ownerId).toBe(login.body.user.id);
    expect(
      await t.prisma.teamMember.count({ where: { teamId: team.id, userId: login.body.user.id } }),
    ).toBe(1);
    expect(await t.prisma.pendingOwner.count({ where: { teamId: team.id } })).toBe(0);
    const mine = await t.http
      .get('/api/teams')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });
    expect(mine.body.map((x: { id: string }) => x.id)).toEqual([team.id]);
    expect(mine.body[0].isOwner).toBe(true);
  });

  it('with the address of an account that never verified it: the team waits instead of going to whoever registered first', async () => {
    const squatter = await signup(t, false);
    const team = await createTeam(squatter.email);
    expect(team).toMatchObject({ owner: null, pendingOwnerEmail: squatter.email, memberCount: 0 });
    expect((await t.http.get('/api/teams').set(squatter.auth)).body).toEqual([]);
  });

  it('refuses non-admins and bad input, lists teams for the admin, and deletes softly', async () => {
    expect(
      (
        await t.http
          .post('/api/admin/teams')
          .set(owner.auth)
          .send({ name: 'x', ownerEmail: owner.email })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.http
          .post('/api/admin/teams')
          .set(admin.auth)
          .send({ name: '', ownerEmail: owner.email })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.http
          .post('/api/admin/teams')
          .set(admin.auth)
          .send({ name: 'x', ownerEmail: 'not-an-email' })
      ).status,
    ).toBe(400);

    const a = await createTeam(owner.email, 'Same Name');
    const b = await createTeam(owner.email, 'Same Name');
    expect(a.slug).not.toBe(b.slug);
    const list = await t.http.get('/api/admin/teams').set(admin.auth);
    expect(list.body.map((x: { id: string }) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect((await t.http.get('/api/admin/stats').set(admin.auth)).body.teams).toBe(2);

    expect((await t.http.delete(`/api/admin/teams/${a.id}`).set(admin.auth)).status).toBe(204);
    expect((await t.http.delete(`/api/admin/teams/${a.id}`).set(admin.auth)).status).toBe(404);
    expect(
      (await t.http.get('/api/admin/teams').set(admin.auth)).body.map((x: { id: string }) => x.id),
    ).toEqual([b.id]);
    expect(
      (await t.http.get('/api/teams').set(owner.auth)).body.map((x: { id: string }) => x.id),
    ).toEqual([b.id]);
    expect((await t.http.get(`/api/teams/${a.id}`).set(owner.auth)).status).toBe(404);
    expect(await t.prisma.team.count({ where: { id: a.id } })).toBe(1); // soft: still there for 30 days
  });
});

// ------------------------------------------------------------------ authorisation

describe('every team and project endpoint: allowed, forbidden, and 404 for people who cannot see it', () => {
  type Who = 'owner' | 'member' | 'projectMember' | 'outsider';
  interface Ctx {
    teamId: string;
    spaceId: string;
    projectId: string;
    childId: string;
    notebookId: string;
  }
  interface Case {
    name: string;
    call: (ctx: Ctx, who: Account) => Promise<{ status: number }>;
    expect: Record<Who, number>;
  }
  let projectMemberAccount: Account;

  beforeEach(async () => {
    projectMemberAccount = await signup(t);
  });

  /** A team with a project Alpha and its sub-project Beta, and a team notebook. owner: everything; member: team only; projectMember: also in Alpha (not Beta). */
  async function fixture(): Promise<Ctx> {
    await t.prisma.team.deleteMany();
    const team = await standardTeam();
    const p = await project(owner, team.id, 'Alpha');
    const c = await project(owner, team.id, 'Beta', p.id);
    await join(team.id, projectMemberAccount);
    await projectMember(p.id, projectMemberAccount);
    const spaceId = (await teamOf(team.id)).spaceId;
    const nb = await t.http
      .post('/api/notebooks')
      .set(owner.auth)
      .send({ id: uuid(), spaceId, name: 'Team notes', position: 'a0' });
    expect(nb.status).toBe(201);
    return { teamId: team.id, spaceId, projectId: p.id, childId: c.id, notebookId: nb.body.id };
  }

  const cases: Case[] = [
    {
      name: 'GET /teams/:id',
      call: (c, w) => t.http.get(`/api/teams/${c.teamId}`).set(w.auth),
      expect: { owner: 200, member: 200, projectMember: 200, outsider: 404 },
    },
    {
      name: 'PATCH /teams/:id',
      call: (c, w) => t.http.patch(`/api/teams/${c.teamId}`).set(w.auth).send({ description: 'x' }),
      expect: { owner: 200, member: 403, projectMember: 403, outsider: 404 },
    },
    {
      name: 'GET /teams/:id/members',
      call: (c, w) => t.http.get(`/api/teams/${c.teamId}/members`).set(w.auth),
      expect: { owner: 200, member: 200, projectMember: 200, outsider: 404 },
    },
    {
      name: 'GET /teams/:id/me',
      call: (c, w) => t.http.get(`/api/teams/${c.teamId}/me`).set(w.auth),
      expect: { owner: 200, member: 200, projectMember: 200, outsider: 404 },
    },
    {
      name: 'GET /teams/:id/projects',
      call: (c, w) => t.http.get(`/api/teams/${c.teamId}/projects`).set(w.auth),
      expect: { owner: 200, member: 200, projectMember: 200, outsider: 404 },
    },
    {
      name: 'POST /teams/:id/projects',
      call: (c, w) =>
        t.http.post(`/api/teams/${c.teamId}/projects`).set(w.auth).send({ name: 'New' }),
      expect: { owner: 201, member: 403, projectMember: 403, outsider: 404 },
    },
    {
      name: 'GET /projects/:id',
      call: (c, w) => t.http.get(`/api/projects/${c.projectId}`).set(w.auth),
      expect: { owner: 200, member: 404, projectMember: 200, outsider: 404 },
    },
    {
      name: 'GET /projects/:id (a sub-project the person is not in)',
      call: (c, w) => t.http.get(`/api/projects/${c.childId}`).set(w.auth),
      expect: { owner: 200, member: 404, projectMember: 404, outsider: 404 },
    },
    {
      name: 'PATCH /projects/:id',
      call: (c, w) =>
        t.http.patch(`/api/projects/${c.projectId}`).set(w.auth).send({ description: 'y' }),
      expect: { owner: 200, member: 404, projectMember: 403, outsider: 404 },
    },
    {
      name: 'POST /projects/:id/move',
      call: (c, w) =>
        t.http.post(`/api/projects/${c.childId}/move`).set(w.auth).send({ parentId: null }),
      expect: { owner: 200, member: 404, projectMember: 404, outsider: 404 },
    },
    {
      name: 'GET /projects/:id/members',
      call: (c, w) => t.http.get(`/api/projects/${c.projectId}/members`).set(w.auth),
      expect: { owner: 200, member: 404, projectMember: 200, outsider: 404 },
    },
    {
      name: 'POST /projects/:id/members',
      call: (c, w) =>
        t.http.post(`/api/projects/${c.projectId}/members`).set(w.auth).send({ userId: owner.id }),
      expect: { owner: 201, member: 404, projectMember: 403, outsider: 404 },
    },
    {
      name: 'DELETE /projects/:id/members/:userId (someone else)',
      call: (c, w) => t.http.delete(`/api/projects/${c.projectId}/members/${uuid()}`).set(w.auth),
      expect: { owner: 204, member: 404, projectMember: 403, outsider: 404 },
    },
    {
      name: 'DELETE /teams/:id/members/:userId (someone else)',
      call: (c, w) => t.http.delete(`/api/teams/${c.teamId}/members/${uuid()}`).set(w.auth),
      expect: { owner: 204, member: 403, projectMember: 403, outsider: 404 },
    },
    {
      name: 'GET /spaces/:id/notebooks (team space)',
      call: (c, w) => t.http.get(`/api/spaces/${c.spaceId}/notebooks`).set(w.auth),
      expect: { owner: 200, member: 200, projectMember: 200, outsider: 404 },
    },
    {
      name: 'GET /notebooks/:id/tree (team notebook)',
      call: (c, w) => t.http.get(`/api/notebooks/${c.notebookId}/tree`).set(w.auth),
      expect: { owner: 200, member: 200, projectMember: 200, outsider: 404 },
    },
    {
      name: 'POST /notebooks in the team space',
      call: (c, w) =>
        t.http
          .post('/api/notebooks')
          .set(w.auth)
          .send({ id: uuid(), spaceId: c.spaceId, name: 'Mine', position: 'a1' }),
      expect: { owner: 201, member: 403, projectMember: 403, outsider: 404 },
    },
    {
      name: 'PATCH /notebooks/:id (team notebook)',
      call: (c, w) =>
        t.http.patch(`/api/notebooks/${c.notebookId}`).set(w.auth).send({ name: 'Renamed' }),
      expect: { owner: 200, member: 403, projectMember: 403, outsider: 404 },
    },
    {
      name: 'DELETE /projects/:id',
      call: (c, w) => t.http.delete(`/api/projects/${c.projectId}`).set(w.auth),
      expect: { owner: 204, member: 404, projectMember: 403, outsider: 404 },
    },
  ];

  it('answers every endpoint as the table says, for the owner, a plain member, a project member and an outsider', async () => {
    for (const c of cases) {
      for (const role of ['owner', 'member', 'projectMember', 'outsider'] as Who[]) {
        const ctx = await fixture(); // fresh each time: some calls delete or move things
        const who: Record<Who, Account> = {
          owner,
          member,
          projectMember: projectMemberAccount,
          outsider,
        };
        const res = await c.call(ctx, who[role]);
        expect(res.status, `${c.name} as ${role}`).toBe(c.expect[role]);
      }
    }
  }, 300_000);
});

// ------------------------------------------------------------------ the hierarchy

describe('projects and sub-projects', () => {
  it('nest to any sensible depth, keep their paths, order and breadcrumbs, and the creator joins', async () => {
    const team = await createTeam(owner.email);
    const a = await project(owner, team.id, 'A');
    const b = await project(owner, team.id, 'B', a.id);
    const c = await project(owner, team.id, 'C', b.id);
    expect([a, b, c].every((p) => p.isMember)).toBe(true);
    expect((await t.prisma.project.findUniqueOrThrow({ where: { id: c.id } })).path).toBe(
      `/${team.id}/${a.id}/${b.id}/${c.id}/`,
    );
    const list = await t.http.get(`/api/teams/${team.id}/projects`).set(owner.auth);
    expect(list.body.map((p: { name: string }) => p.name)).toEqual(['A', 'B', 'C']);
    // every project has a space of its own
    expect(
      await t.prisma.space.count({
        where: { kind: 'project', projectId: { in: [a.id, b.id, c.id] } },
      }),
    ).toBe(3);
  });

  it('stops at the maximum depth and at MAX_PROJECTS_PER_TEAM (an admin override can raise or lower it)', async () => {
    const team = await createTeam(owner.email);
    let parent: string | null = null;
    for (let i = 1; i <= 16; i++) parent = (await project(owner, team.id, `L${i}`, parent)).id;
    const tooDeep = await t.http
      .post(`/api/teams/${team.id}/projects`)
      .set(owner.auth)
      .send({ name: 'L17', parentId: parent });
    expect(tooDeep.status).toBe(422);

    const small = await createTeam(owner.email, 'Small');
    expect(
      (
        await t.http
          .put(`/api/admin/quotas/team/${small.id}`)
          .set(admin.auth)
          .send({ maxProjects: 2 })
      ).status,
    ).toBe(200);
    await project(owner, small.id, 'one');
    await project(owner, small.id, 'two');
    const third = await t.http
      .post(`/api/teams/${small.id}/projects`)
      .set(owner.auth)
      .send({ name: 'three' });
    expect(third.status).toBe(409);
    expect(third.body.message).toBe('project_limit_reached');
  });

  it('a sub-project cannot gain a member who is not in its parent', async () => {
    const team = await standardTeam();
    const parent = await project(owner, team.id, 'Parent');
    const child = await project(owner, team.id, 'Child', parent.id);
    const add = (id: string, who: Account) =>
      t.http.post(`/api/projects/${id}/members`).set(owner.auth).send({ userId: who.id });

    expect((await add(child.id, member)).status).toBe(422); // in the team, not in the parent
    expect((await add(parent.id, member)).status).toBe(201);
    expect((await add(child.id, member)).status).toBe(201);
    expect((await add(child.id, outsider)).status).toBe(422); // not even in the team
    expect(
      (
        await t.http
          .post(`/api/projects/${parent.id}/members`)
          .set(owner.auth)
          .send({ userId: outsider.id })
      ).status,
    ).toBe(422);
  });

  it('removing someone from a project removes them from everything below it', async () => {
    const team = await standardTeam();
    const parent = await project(owner, team.id, 'Parent');
    const child = await project(owner, team.id, 'Child', parent.id);
    await projectMember(parent.id, member);
    await projectMember(child.id, member);
    expect(
      (await t.http.delete(`/api/projects/${parent.id}/members/${member.id}`).set(owner.auth))
        .status,
    ).toBe(204);
    expect(await t.prisma.projectMember.count({ where: { userId: member.id } })).toBe(0);
  });

  it('removing a team member removes them from every project below, and the owner cannot be removed', async () => {
    const team = await standardTeam();
    const a = await project(owner, team.id, 'A');
    const b = await project(owner, team.id, 'B', a.id);
    const other = await project(owner, team.id, 'Other');
    for (const p of [a, b, other]) await projectMember(p.id, member);

    expect(
      (await t.http.delete(`/api/teams/${team.id}/members/${owner.id}`).set(owner.auth)).status,
    ).toBe(422);
    expect(
      (await t.http.delete(`/api/teams/${team.id}/members/${member.id}`).set(owner.auth)).status,
    ).toBe(204);
    expect(await t.prisma.projectMember.count({ where: { userId: member.id } })).toBe(0);
    expect(await t.prisma.teamMember.count({ where: { userId: member.id } })).toBe(0);
    expect((await t.http.get(`/api/teams/${team.id}`).set(member.auth)).status).toBe(404);

    // people may leave on their own
    await join(team.id, outsider);
    expect(
      (await t.http.delete(`/api/teams/${team.id}/members/${outsider.id}`).set(outsider.auth))
        .status,
    ).toBe(204);
  });

  it('moving: into its own descendant, into itself and across teams are all refused; a legal move updates the whole subtree', async () => {
    const team = await createTeam(owner.email);
    const a = await project(owner, team.id, 'A');
    const b = await project(owner, team.id, 'B', a.id);
    const c = await project(owner, team.id, 'C', b.id);
    const z = await project(owner, team.id, 'Z');
    const move = (id: string, parentId: string | null) =>
      t.http.post(`/api/projects/${id}/move`).set(owner.auth).send({ parentId });

    expect((await move(a.id, c.id)).status).toBe(422); // below itself
    expect((await move(a.id, b.id)).status).toBe(422);
    expect((await move(a.id, a.id)).status).toBe(422); // into itself

    const other = await createTeam(owner.email, 'Other team');
    const foreign = await project(owner, other.id, 'Foreign');
    expect((await move(a.id, foreign.id)).status).toBe(422);

    const ok = await move(b.id, z.id);
    expect(ok.status).toBe(200);
    expect(ok.body.parentId).toBe(z.id);
    const paths = Object.fromEntries(
      (await t.prisma.project.findMany({ where: { teamId: team.id } })).map((p) => [
        p.name,
        p.path,
      ]),
    );
    expect(paths['B']).toBe(`/${team.id}/${z.id}/${b.id}/`);
    expect(paths['C']).toBe(`/${team.id}/${z.id}/${b.id}/${c.id}/`);
    expect(paths['A']).toBe(`/${team.id}/${a.id}/`);

    expect((await move(c.id, null)).status).toBe(200); // to the top
    expect((await t.prisma.project.findUniqueOrThrow({ where: { id: c.id } })).path).toBe(
      `/${team.id}/${c.id}/`,
    );
  });

  it('moving needs MANAGE_PROJECTS on both sides and takes members the new parent lacks out of the moved project', async () => {
    const team = await standardTeam();
    const a = await project(owner, team.id, 'A');
    const target = await project(owner, team.id, 'Target');
    const inner = await project(owner, team.id, 'Inner', a.id);
    await projectMember(a.id, member);
    await projectMember(inner.id, member);
    expect(
      (
        await t.http
          .post(`/api/projects/${inner.id}/move`)
          .set(member.auth)
          .send({ parentId: target.id })
      ).status,
    ).toBe(403); // sees Inner, but may not manage projects
    expect(
      (
        await t.http
          .post(`/api/projects/${inner.id}/move`)
          .set(owner.auth)
          .send({ parentId: target.id })
      ).status,
    ).toBe(200);
    expect(
      await t.prisma.projectMember.count({ where: { projectId: inner.id, userId: member.id } }),
    ).toBe(0); // not in Target
    expect(
      await t.prisma.projectMember.count({ where: { projectId: inner.id, userId: owner.id } }),
    ).toBe(1);
  });

  it('deleting a project (soft) hides it and everything under it at once', async () => {
    const team = await createTeam(owner.email);
    const a = await project(owner, team.id, 'A');
    const b = await project(owner, team.id, 'B', a.id);
    expect((await t.http.delete(`/api/projects/${a.id}`).set(owner.auth)).status).toBe(204);
    expect((await t.http.get(`/api/projects/${b.id}`).set(owner.auth)).status).toBe(404);
    expect((await t.http.get(`/api/teams/${team.id}/projects`).set(owner.auth)).body).toEqual([]);
    expect(await t.prisma.project.count({ where: { teamId: team.id } })).toBe(2);
  });

  it('archives and unarchives, and renames', async () => {
    const team = await createTeam(owner.email);
    const a = await project(owner, team.id, 'A');
    const arch = await t.http
      .patch(`/api/projects/${a.id}`)
      .set(owner.auth)
      .send({ archived: true, name: 'A2' });
    expect(arch.body).toMatchObject({ name: 'A2' });
    expect(arch.body.archivedAt).not.toBeNull();
    expect(
      (await t.http.patch(`/api/projects/${a.id}`).set(owner.auth).send({ archived: false })).body
        .archivedAt,
    ).toBeNull();
  });

  it('a team member sees only the projects they belong to; the owner sees all', async () => {
    const team = await standardTeam();
    const a = await project(owner, team.id, 'Secret');
    const b = await project(owner, team.id, 'Shared');
    await projectMember(b.id, member);
    expect(
      (await t.http.get(`/api/teams/${team.id}/projects`).set(owner.auth)).body
        .map((p: { id: string }) => p.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(
      (await t.http.get(`/api/teams/${team.id}/projects`).set(member.auth)).body.map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual([b.id]);
    const me = (await t.http.get(`/api/teams/${team.id}/me`).set(member.auth)).body;
    expect(Object.keys(me.projects)).toEqual([b.id]);
    expect(
      hasPermission(permissionsFromString(me.projects[b.id])!, Permission.VIEW_NOTEBOOKS),
    ).toBe(true);
    expect(
      hasPermission(permissionsFromString(me.projects[b.id])!, Permission.MANAGE_PROJECTS),
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ content in team spaces

describe('notebooks of a team or project space', () => {
  it('are read by members, written by people with the permission, and invisible to everybody else', async () => {
    const team = await standardTeam();
    const teamSpace = (await teamOf(team.id)).spaceId;
    const nb = await t.http
      .post('/api/notebooks')
      .set(owner.auth)
      .send({ id: uuid(), spaceId: teamSpace, name: 'Wiki', position: 'a0' });
    expect(nb.status).toBe(201);
    const cat = await t.http
      .post('/api/categories')
      .set(owner.auth)
      .send({ id: uuid(), notebookId: nb.body.id, name: 'Docs', position: 'a0' });
    expect(cat.status).toBe(201);
    const page = await t.http
      .post('/api/pages')
      .set(owner.auth)
      .send({ id: uuid(), categoryId: cat.body.id, title: 'Readme', position: 'a0' });
    expect(page.status).toBe(201);
    expect(
      (
        await t.http
          .post(`/api/pages/${page.body.id}/snapshots/replace`)
          .set(owner.auth)
          .send({ content: para('Welcome'), baseVersion: 0 })
      ).status,
    ).toBe(200);

    // a member reads...
    expect(
      (await t.http.get(`/api/pages/${page.body.id}`).set(member.auth)).body.content,
    ).toBeDefined();
    expect(
      (await t.http.get(`/api/notebooks/${nb.body.id}/tree`).set(member.auth)).body.pages,
    ).toHaveLength(1);
    expect(
      (await t.http.get('/api/pages').query({ notebookId: nb.body.id }).set(member.auth)).status,
    ).toBe(200);
    // ...but cannot change anything
    expect(
      (
        await t.http
          .post(`/api/pages/${page.body.id}/snapshots/replace`)
          .set(member.auth)
          .send({ content: para('hack'), baseVersion: 1 })
      ).status,
    ).toBe(403);
    expect((await t.http.delete(`/api/pages/${page.body.id}`).set(member.auth)).status).toBe(403);
    expect(
      (
        await t.http
          .post('/api/pages')
          .set(member.auth)
          .send({ id: uuid(), categoryId: cat.body.id, title: 'mine', position: 'a1' })
      ).status,
    ).toBe(403);
    expect(
      (await t.http.patch(`/api/categories/${cat.body.id}`).set(member.auth).send({ name: 'x' }))
        .status,
    ).toBe(403);
    expect((await t.http.delete(`/api/notebooks/${nb.body.id}`).set(member.auth)).status).toBe(403);
    // an outsider gets 404 for all of it, and cannot even tell whether the ids exist
    for (const res of [
      await t.http.get(`/api/pages/${page.body.id}`).set(outsider.auth),
      await t.http.get(`/api/notebooks/${nb.body.id}/tree`).set(outsider.auth),
      await t.http
        .post(`/api/pages/${page.body.id}/snapshots/replace`)
        .set(outsider.auth)
        .send({ content: para('x'), baseVersion: 1 }),
      await t.http.delete(`/api/pages/${page.body.id}`).set(outsider.auth),
      await t.http.get(`/api/spaces/${teamSpace}/notebooks`).set(outsider.auth),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await t.http.get(`/api/pages/${uuid()}`).set(outsider.auth)).status).toBe(404);

    // personal and team notebooks stay apart
    expect((await t.http.get('/api/notebooks').set(owner.auth)).body).toEqual([]);
    expect(
      (await t.http.get(`/api/spaces/${teamSpace}/notebooks`).set(member.auth)).body.map(
        (n: { id: string }) => n.id,
      ),
    ).toEqual([nb.body.id]);
  });

  it('are found by search for members of the space and for nobody else', async () => {
    const team = await standardTeam();
    const space = (await teamOf(team.id)).spaceId;
    const nb = (
      await t.http
        .post('/api/notebooks')
        .set(owner.auth)
        .send({ id: uuid(), spaceId: space, name: 'Wiki', position: 'a0' })
    ).body;
    const cat = (
      await t.http
        .post('/api/categories')
        .set(owner.auth)
        .send({ id: uuid(), notebookId: nb.id, name: 'Docs', position: 'a0' })
    ).body;
    const page = (
      await t.http
        .post('/api/pages')
        .set(owner.auth)
        .send({ id: uuid(), categoryId: cat.id, title: 'Xylophone handbook', position: 'a0' })
    ).body;
    await t.http
      .post(`/api/pages/${page.id}/snapshots/replace`)
      .set(owner.auth)
      .send({ content: para('the xylophone is in the cupboard'), baseVersion: 0 });

    const found = await t.http.get('/api/search').query({ q: 'xylophone' }).set(member.auth);
    expect(found.body.map((r: { pageId: string }) => r.pageId)).toEqual([page.id]);
    expect(found.body[0].spaceId).toBe(space);
    expect(
      (await t.http.get('/api/search').query({ q: 'xylophone' }).set(outsider.auth)).body,
    ).toEqual([]);

    await t.prisma.teamMember.delete({
      where: { teamId_userId: { teamId: team.id, userId: member.id } },
    });
    expect(
      (await t.http.get('/api/search').query({ q: 'xylophone' }).set(member.auth)).body,
    ).toEqual([]);
  });

  it('cannot be reached by id through a space the person lost: removal, deletion of the team, deletion of the project', async () => {
    const team = await standardTeam();
    const p = await project(owner, team.id, 'P');
    await projectMember(p.id, member);
    const nb = await t.http
      .post('/api/notebooks')
      .set(owner.auth)
      .send({ id: uuid(), spaceId: p.spaceId, name: 'In project', position: 'a0' });
    expect(nb.status).toBe(201);
    expect((await t.http.get(`/api/notebooks/${nb.body.id}/tree`).set(member.auth)).status).toBe(
      200,
    );
    await t.http.delete(`/api/projects/${p.id}/members/${member.id}`).set(owner.auth);
    expect((await t.http.get(`/api/notebooks/${nb.body.id}/tree`).set(member.auth)).status).toBe(
      404,
    );
    expect((await t.http.get(`/api/notebooks/${nb.body.id}/tree`).set(owner.auth)).status).toBe(
      200,
    );
    await t.http.delete(`/api/admin/teams/${team.id}`).set(admin.auth);
    expect((await t.http.get(`/api/notebooks/${nb.body.id}/tree`).set(owner.auth)).status).toBe(
      404,
    );
  });

  it('a page cannot be moved into a category of another space', async () => {
    const team = await createTeam(owner.email);
    const teamSpace = (await teamOf(team.id)).spaceId;
    const tn = (
      await t.http
        .post('/api/notebooks')
        .set(owner.auth)
        .send({ id: uuid(), spaceId: teamSpace, name: 'T', position: 'a0' })
    ).body;
    const tc = (
      await t.http
        .post('/api/categories')
        .set(owner.auth)
        .send({ id: uuid(), notebookId: tn.id, name: 'C', position: 'a0' })
    ).body;
    const tp = (
      await t.http
        .post('/api/pages')
        .set(owner.auth)
        .send({ id: uuid(), categoryId: tc.id, title: 'P', position: 'a0' })
    ).body;
    const mine = (
      await t.http
        .post('/api/notebooks')
        .set(owner.auth)
        .send({ id: uuid(), name: 'Mine', position: 'a0' })
    ).body;
    const mc = (
      await t.http
        .post('/api/categories')
        .set(owner.auth)
        .send({ id: uuid(), notebookId: mine.id, name: 'C', position: 'a0' })
    ).body;
    const res = await t.http
      .patch(`/api/pages/${tp.id}`)
      .set(owner.auth)
      .send({ categoryId: mc.id });
    expect(res.status).toBe(422);
  });

  it('refuse an id that already belongs to another space', async () => {
    const team = await createTeam(owner.email);
    const space = (await teamOf(team.id)).spaceId;
    const id = uuid();
    expect(
      (
        await t.http
          .post('/api/notebooks')
          .set(owner.auth)
          .send({ id, spaceId: space, name: 'T', position: 'a0' })
      ).status,
    ).toBe(201);
    expect(
      (
        await t.http
          .post('/api/notebooks')
          .set(owner.auth)
          .send({ id, name: 'Mine', position: 'a0' })
      ).status,
    ).toBe(409);
    // repeating the same create is fine
    expect(
      (
        await t.http
          .post('/api/notebooks')
          .set(owner.auth)
          .send({ id, spaceId: space, name: 'T', position: 'a0' })
      ).status,
    ).toBe(201);
  });
});

// ------------------------------------------------------------------ storage

describe('storage of teams and projects', () => {
  const save = (who: Account, pageId: string, text: string, baseVersion: number) =>
    t.http
      .post(`/api/pages/${pageId}/snapshots/replace`)
      .set(who.auth)
      .send({ content: para(text), baseVersion });

  it('is charged to the space that holds the content, and a project also counts toward its team', async () => {
    const quota = t.app.get(QuotaService);
    const team = await createTeam(owner.email);
    const p = await project(owner, team.id, 'P');
    const teamSpace = (await teamOf(team.id)).spaceId;

    const makePage = async (spaceId: string) => {
      const nb = (
        await t.http
          .post('/api/notebooks')
          .set(owner.auth)
          .send({ id: uuid(), spaceId, name: 'N', position: 'a0' })
      ).body;
      const cat = (
        await t.http
          .post('/api/categories')
          .set(owner.auth)
          .send({ id: uuid(), notebookId: nb.id, name: 'C', position: 'a0' })
      ).body;
      return (
        await t.http
          .post('/api/pages')
          .set(owner.auth)
          .send({ id: uuid(), categoryId: cat.id, title: 'T', position: 'a0' })
      ).body as { id: string };
    };
    const teamPage = await makePage(teamSpace);
    const projectPage = await makePage(p.spaceId);
    expect((await save(owner, teamPage.id, 'x'.repeat(1000), 0)).status).toBe(200);
    expect((await save(owner, projectPage.id, 'y'.repeat(2000), 0)).status).toBe(200);

    const teamOwn = (await t.prisma.page.findUniqueOrThrow({ where: { id: teamPage.id } }))
      .sizeBytes;
    const projectOwn = (await t.prisma.page.findUniqueOrThrow({ where: { id: projectPage.id } }))
      .sizeBytes;
    expect(await quota.usage('project', p.id)).toBe(projectOwn);
    expect(await quota.usage('team', team.id)).toBe(teamOwn + projectOwn); // the team total includes its projects
    expect(await quota.usage('user', owner.id)).toBe(0); // nothing of this is the owner's personal storage

    const breakdown = await quota.breakdown('team', team.id);
    expect(breakdown.documents).toBe(teamOwn + projectOwn);

    // shrinking gives it back, at both levels
    await save(owner, projectPage.id, 'z', 1);
    const projectNow = (await t.prisma.page.findUniqueOrThrow({ where: { id: projectPage.id } }))
      .sizeBytes;
    expect(await quota.usage('project', p.id)).toBe(projectNow);
    expect(await quota.usage('team', team.id)).toBe(teamOwn + projectNow);
  });

  it('is limited by the project limit and by the team limit, atomically across both', async () => {
    const team = await createTeam(owner.email);
    const p = await project(owner, team.id, 'P');
    const nb = (
      await t.http
        .post('/api/notebooks')
        .set(owner.auth)
        .send({ id: uuid(), spaceId: p.spaceId, name: 'N', position: 'a0' })
    ).body;
    const cat = (
      await t.http
        .post('/api/categories')
        .set(owner.auth)
        .send({ id: uuid(), notebookId: nb.id, name: 'C', position: 'a0' })
    ).body;
    const page = (
      await t.http
        .post('/api/pages')
        .set(owner.auth)
        .send({ id: uuid(), categoryId: cat.id, title: 'T', position: 'a0' })
    ).body;

    const used = await t.app.get(QuotaService).usage('project', p.id);
    await t.http
      .put(`/api/admin/quotas/project/${p.id}`)
      .set(admin.auth)
      .send({ storageBytes: used + 300 });
    const refused = await save(owner, page.id, 'a'.repeat(1000), 0);
    expect(refused.status).toBe(413);
    expect(refused.body).toMatchObject({
      code: 'quota_exceeded',
      scope: 'project',
      limit: used + 300,
    });

    // lift the project limit; now the team's applies
    await t.http.delete(`/api/admin/quotas/project/${p.id}`).set(admin.auth);
    const teamUsed = await t.app.get(QuotaService).usage('team', team.id);
    await t.http
      .put(`/api/admin/quotas/team/${team.id}`)
      .set(admin.auth)
      .send({ storageBytes: teamUsed + 300 });
    const refusedByTeam = await save(owner, page.id, 'a'.repeat(1000), 0);
    expect(refusedByTeam.status).toBe(413);
    expect(refusedByTeam.body).toMatchObject({ scope: 'team' });
    // nothing was charged at either level
    expect(await t.app.get(QuotaService).usage('project', p.id)).toBe(used);
    expect(await t.app.get(QuotaService).usage('team', team.id)).toBe(teamUsed);
  });

  it('is handed back when the trash is purged, and when a project is purged its team gets its bytes back', async () => {
    const maintenance = t.app.get(MaintenanceService);
    const quota = t.app.get(QuotaService);
    const team = await createTeam(owner.email);
    const p = await project(owner, team.id, 'P');
    const nb = (
      await t.http
        .post('/api/notebooks')
        .set(owner.auth)
        .send({ id: uuid(), spaceId: p.spaceId, name: 'N', position: 'a0' })
    ).body;
    const cat = (
      await t.http
        .post('/api/categories')
        .set(owner.auth)
        .send({ id: uuid(), notebookId: nb.id, name: 'C', position: 'a0' })
    ).body;
    const page = (
      await t.http
        .post('/api/pages')
        .set(owner.auth)
        .send({ id: uuid(), categoryId: cat.id, title: 'T', position: 'a0' })
    ).body;
    await save(owner, page.id, 'q'.repeat(500), 0);
    expect(await quota.usage('team', team.id)).toBeGreaterThan(500);

    await t.http.delete(`/api/projects/${p.id}`).set(owner.auth);
    await maintenance.purgeDeletedContainers(); // nothing is old enough yet
    expect(await t.prisma.project.count({ where: { id: p.id } })).toBe(1);
    expect(await quota.usage('team', team.id)).toBeGreaterThan(500);

    await t.prisma.project.updateMany({
      where: { id: p.id },
      data: { deletedAt: new Date(Date.now() - 31 * DAY) },
    });
    expect(await maintenance.purgeDeletedContainers()).toEqual({ teams: 0, projects: 1 });
    expect(await t.prisma.project.count({ where: { id: p.id } })).toBe(0);
    expect(await t.prisma.space.count({ where: { id: p.spaceId } })).toBe(0);
    expect(await t.prisma.page.count({ where: { id: page.id } })).toBe(0);
    expect(await quota.usage('team', team.id)).toBe(0);

    await t.http.delete(`/api/admin/teams/${team.id}`).set(admin.auth);
    await t.prisma.team.update({
      where: { id: team.id },
      data: { deletedAt: new Date(Date.now() - 31 * DAY) },
    });
    expect(await maintenance.purgeDeletedContainers()).toEqual({ teams: 1, projects: 0 });
    expect(await t.prisma.team.count({ where: { id: team.id } })).toBe(0);
  });

  it('limits the number of members of a team', async () => {
    const team = await createTeam(owner.email);
    await t.http.put(`/api/admin/quotas/team/${team.id}`).set(admin.auth).send({ maxMembers: 2 });
    const { TeamsService } = await import('../src/teams/teams.service.js');
    const svc = t.app.get(TeamsService);
    await t.prisma.$transaction((tx) => svc.addMember(tx, team.id, member.id));
    await expect(
      t.prisma.$transaction((tx) => svc.addMember(tx, team.id, outsider.id)),
    ).rejects.toMatchObject({ response: { code: 'quota_exceeded', scope: 'team', limit: 2 } });
    // adding someone who is already in is not a second seat
    await t.prisma.$transaction((tx) => svc.addMember(tx, team.id, member.id));
  });

  it('personal storage is untouched by team content, and a media upload to a team space is charged there', async () => {
    const { png } = await import('./fixtures.js');
    const team = await createTeam(owner.email);
    const quota = t.app.get(QuotaService);
    const space = (await teamOf(team.id)).spaceId;
    const img = await png(20, 20);
    const mediaId = uuid();
    const up = await t.http
      .post('/api/media')
      .set(owner.auth)
      .field('id', mediaId)
      .field('spaceId', space)
      .attach('file', img, 'a.png');
    expect(up.status).toBe(201);
    expect(await quota.usage('team', team.id)).toBe(up.body.size);
    expect(await quota.usage('user', owner.id)).toBe(0);

    // members may look at it, outsiders may not, and members may not upload there
    expect((await t.http.get(`/api/media/${mediaId}`).set(member.auth)).status).toBe(404); // not a member yet
    await join(team.id, member);
    expect((await t.http.get(`/api/media/${mediaId}`).set(member.auth)).status).toBe(200);
    expect((await t.http.get(`/api/media/${mediaId}`).set(outsider.auth)).status).toBe(404);
    expect(
      (
        await t.http
          .post('/api/media')
          .set(member.auth)
          .field('id', uuid())
          .field('spaceId', space)
          .attach('file', img, 'b.png')
      ).status,
    ).toBe(403);
    expect(
      (
        await t.http
          .post('/api/media')
          .set(outsider.auth)
          .field('id', uuid())
          .field('spaceId', space)
          .attach('file', img, 'c.png')
      ).status,
    ).toBe(404);
    expect(await personalSpaceId(t, owner.id)).toBeDefined();
  });
});
