import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  hasPermission,
  Permission,
  permissionsFromString,
  permissionsToString,
  positionBetween,
} from '@os-planner/shared';
import { MaintenanceService } from '../src/media/maintenance.service.js';
import { AuditService } from '../src/roles/audit.service.js';
import { createTestApp, type TestApp } from './app.js';
import { signup, type Account } from './helpers.js';

const P = Permission;
const ADMIN_EMAIL = `roles-admin${Date.now()}@example.com`;

let t: TestApp;
let saved: string | undefined;
let admin: Account;
let owner: Account;
let mid: Account;
let plain: Account;
let other: Account;
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
  mid = await signup(t);
  plain = await signup(t);
  other = await signup(t);
  outsider = await signup(t);
});

// ------------------------------------------------------------------ helpers

const bits = (...b: bigint[]): string => permissionsToString(b.reduce((a, x) => a | x, 0n));

async function newTeam(): Promise<string> {
  const res = await t.http
    .post('/api/admin/teams')
    .set(admin.auth)
    .send({ name: 'Rocket', ownerEmail: owner.email });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const who of [mid, plain, other])
    await t.prisma.teamMember.create({ data: { teamId: res.body.id, userId: who.id } });
  return res.body.id as string;
}

interface Role {
  id: string;
  name: string;
  position: number;
  permissions: string;
  projectId: string | null;
  isEveryone: boolean;
  memberCount: number;
  [k: string]: unknown;
}

const createRole = (who: Account, teamId: string, body: object) =>
  t.http.post(`/api/teams/${teamId}/roles`).set(who.auth).send(body);
async function role(
  who: Account,
  teamId: string,
  name: string,
  permissions: string = '0',
  extra: object = {},
): Promise<Role> {
  const res = await createRole(who, teamId, { name, permissions, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Role;
}
const assign = (who: Account, teamId: string, userId: string, roleId: string) =>
  t.http.put(`/api/teams/${teamId}/members/${userId}/roles/${roleId}`).set(who.auth);
const unassign = (who: Account, teamId: string, userId: string, roleId: string) =>
  t.http.delete(`/api/teams/${teamId}/members/${userId}/roles/${roleId}`).set(who.auth);
const patchRole = (who: Account, roleId: string, body: object) =>
  t.http.patch(`/api/roles/${roleId}`).set(who.auth).send(body);
const deleteRole = (who: Account, roleId: string) =>
  t.http.delete(`/api/roles/${roleId}`).set(who.auth);
const roleList = async (who: Account, teamId: string): Promise<Role[]> =>
  (await t.http.get(`/api/teams/${teamId}/roles`).set(who.auth)).body;
const everyoneOf = async (teamId: string) =>
  t.prisma.role.findFirstOrThrow({ where: { teamId, isEveryone: true } });

let lastPos: string | null = null;
async function project(
  who: Account,
  teamId: string,
  name = 'Project',
  parentId: string | null = null,
) {
  lastPos = positionBetween(lastPos, null);
  const res = await t.http
    .post(`/api/teams/${teamId}/projects`)
    .set(who.auth)
    .send({ name, parentId, position: lastPos });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; spaceId: string };
}
const inProject = (projectId: string, who: Account) =>
  t.prisma.projectMember.create({ data: { projectId, userId: who.id } });

const setOverwrite = (who: Account, body: object) =>
  t.http.put('/api/overwrites').set(who.auth).send(body);
const overwrite = (
  projectId: string,
  subjectKind: 'role' | 'member',
  subjectId: string,
  allow: string,
  deny: string,
) => ({
  targetKind: 'project',
  targetId: projectId,
  subjectKind,
  subjectId,
  allow,
  deny,
});
const meIn = async (who: Account, teamId: string, projectId?: string): Promise<bigint> => {
  const res = await t.http.get(`/api/teams/${teamId}/me`).set(who.auth);
  expect(res.status).toBe(200);
  const raw = projectId ? res.body.projects[projectId] : res.body.permissions;
  return raw === undefined ? -1n : (permissionsFromString(raw) ?? -1n);
};
const can = (set: bigint, bit: bigint) => set >= 0n && hasPermission(set, bit);

const auditRows = (teamId: string) =>
  t.prisma.auditLog.findMany({ where: { teamId }, orderBy: { id: 'asc' } });
const auditCount = (teamId: string) => t.prisma.auditLog.count({ where: { teamId } });
const viewAudit = (who: Account, teamId: string, query: object = {}) =>
  t.http.get(`/api/teams/${teamId}/audit`).set(who.auth).query(query);

/** Gives a person the right to read the audit log, through a role created by the owner. */
async function allowAudit(teamId: string, who: Account) {
  const r = await role(owner, teamId, 'Auditor', bits(P.VIEW_AUDIT_LOG));
  expect((await assign(owner, teamId, who.id, r.id)).status).toBe(204);
  return r;
}

// ------------------------------------------------------------------ the basics

describe('team roles', () => {
  it('the owner creates, lists, edits, assigns, unassigns and deletes a role', async () => {
    const team = await newTeam();
    const reviewer = await role(owner, team, 'Reviewer', bits(P.EDIT_PAGES), {
      color: '#3366cc',
      mentionable: true,
      hoist: true,
    });
    expect(reviewer).toMatchObject({
      name: 'Reviewer',
      color: '#3366cc',
      mentionable: true,
      hoist: true,
      position: 1,
      projectId: null,
      isEveryone: false,
      memberCount: 0,
    });
    expect(permissionsFromString(reviewer.permissions)).toBe(P.EDIT_PAGES);

    const second = await role(owner, team, 'Second');
    expect(second.position).toBe(1); // new roles start at the bottom ...
    const list = await roleList(plain, team); // ... and any member may read the list
    expect(list.map((r) => [r.name, r.position])).toEqual([
      ['Reviewer', 2],
      ['Second', 1],
      ['@everyone', 0],
    ]);

    expect((await assign(owner, team, plain.id, reviewer.id)).status).toBe(204);
    expect((await assign(owner, team, plain.id, reviewer.id)).status).toBe(204); // again: nothing changes
    const members = await t.http.get(`/api/teams/${team}/members`).set(owner.auth);
    expect(members.body.find((m: { userId: string }) => m.userId === plain.id).roleIds).toEqual([
      reviewer.id,
    ]);
    expect((await roleList(owner, team)).find((r) => r.id === reviewer.id)!.memberCount).toBe(1);

    const edited = await patchRole(owner, reviewer.id, {
      name: 'Senior reviewer',
      permissions: bits(P.EDIT_PAGES, P.DELETE_PAGES),
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ name: 'Senior reviewer', memberCount: 1 });

    expect((await unassign(owner, team, plain.id, reviewer.id)).status).toBe(204);
    expect((await unassign(owner, team, plain.id, reviewer.id)).status).toBe(204);
    expect((await deleteRole(owner, reviewer.id)).status).toBe(204);
    expect((await roleList(owner, team)).map((r) => r.name)).toEqual(['Second', '@everyone']);
  });

  it('a role really changes what a member may do', async () => {
    const team = await newTeam();
    const project1 = await project(owner, team);
    await inProject(project1.id, plain);
    expect(can(await meIn(plain, team, project1.id), P.EDIT_PAGES)).toBe(false);
    const editors = await role(owner, team, 'Editors', bits(P.EDIT_PAGES));
    await assign(owner, team, plain.id, editors.id);
    expect(can(await meIn(plain, team, project1.id), P.EDIT_PAGES)).toBe(true);
    expect(can(await meIn(plain, team), P.EDIT_PAGES)).toBe(true);
    await unassign(owner, team, plain.id, editors.id);
    expect(can(await meIn(plain, team, project1.id), P.EDIT_PAGES)).toBe(false);
  });

  it('roles must belong to the team, and only members can hold them', async () => {
    const team = await newTeam();
    const r = await role(owner, team, 'R');
    expect((await assign(owner, team, outsider.id, r.id)).status).toBe(404); // not a member
    const otherTeam = await newTeam();
    const foreign = await role(owner, otherTeam, 'Foreign');
    expect((await assign(owner, team, plain.id, foreign.id)).status).toBe(404); // role of another team
    const everyone = await everyoneOf(team);
    expect((await assign(owner, team, plain.id, everyone.id)).status).toBe(404); // @everyone is implicit
  });

  it('refuses invalid input', async () => {
    const team = await newTeam();
    expect((await createRole(owner, team, { name: '' })).status).toBe(400);
    expect((await createRole(owner, team, { name: 'x'.repeat(41) })).status).toBe(400);
    expect((await createRole(owner, team, { name: 'x', color: 'red' })).status).toBe(400);
    expect((await createRole(owner, team, { name: 'x', permissions: '-1' })).status).toBe(400);
    expect(
      (await createRole(owner, team, { name: 'x', permissions: (1n << 50n).toString() })).status,
    ).toBe(400); // a reserved bit
    expect((await createRole(owner, team, { name: 'x', permissions: 'abc' })).status).toBe(400);
  });

  it('a team has at most MAX_ROLES_PER_TEAM roles', async () => {
    const team = await newTeam();
    const now = new Date();
    await t.prisma.role.createMany({
      data: Array.from({ length: 99 }, (_, i) => ({
        id: crypto.randomUUID(),
        teamId: team,
        name: `bulk${i}`,
        position: i + 1,
        permissions: 0n,
        createdAt: now,
      })),
    });
    expect((await createRole(owner, team, { name: 'the hundredth' })).status).toBe(201);
    expect((await createRole(owner, team, { name: 'one too many' })).status).toBe(409);
  });

  it('creating with a client id is idempotent', async () => {
    const team = await newTeam();
    const id = crypto.randomUUID();
    const first = await createRole(owner, team, { id, name: 'Same' });
    const again = await createRole(owner, team, { id, name: 'Same' });
    expect([first.status, again.status]).toEqual([201, 201]);
    expect((await roleList(owner, team)).filter((r) => r.name === 'Same')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ hierarchy (criterion 3)

describe('the role hierarchy on the server', () => {
  async function ladder() {
    const team = await newTeam();
    // Created top-down: every new role starts at the bottom, so Boss ends up highest.
    const boss = await role(
      owner,
      team,
      'Boss',
      bits(P.MANAGE_ROLES, P.EDIT_PAGES, P.DELETE_PAGES, P.CREATE_NOTEBOOKS, P.VIEW_NOTEBOOKS),
    );
    const middle = await role(
      owner,
      team,
      'Mid',
      bits(P.MANAGE_ROLES, P.EDIT_PAGES, P.VIEW_NOTEBOOKS),
    );
    const low = await role(owner, team, 'Low', bits(P.EDIT_PAGES));
    expect((await assign(owner, team, mid.id, middle.id)).status).toBe(204);
    expect((await roleList(owner, team)).map((r) => [r.name, r.position])).toEqual([
      ['Boss', 3],
      ['Mid', 2],
      ['Low', 1],
      ['@everyone', 0],
    ]);
    return { team, boss, middle, low };
  }

  it('a member with MANAGE_ROLES cannot touch a role at or above their own, nor grant what they lack, and nothing is logged', async () => {
    const { team, boss, middle, low } = await ladder();
    const before = await auditCount(team);

    const refused: Array<[string, { status: number }]> = [
      ['edit a higher role', await patchRole(mid, boss.id, { name: 'Hacked' })],
      ['edit their own role', await patchRole(mid, middle.id, { name: 'Mine' })],
      ['delete a higher role', await deleteRole(mid, boss.id)],
      ['delete their own role', await deleteRole(mid, middle.id)],
      ['assign a higher role', await assign(mid, team, plain.id, boss.id)],
      ['assign their own role', await assign(mid, team, plain.id, middle.id)],
      ['promote themselves', await assign(mid, team, mid.id, boss.id)],
      ['unassign a higher role', await unassign(mid, team, owner.id, boss.id)],
      [
        'give a lower role a permission they lack',
        await patchRole(mid, low.id, { permissions: bits(P.EDIT_PAGES, P.DELETE_PAGES) }),
      ],
      [
        'create a role with a permission they lack',
        await createRole(mid, team, { name: 'Sneaky', permissions: bits(P.CREATE_NOTEBOOKS) }),
      ],
      [
        'create a role with ADMINISTRATOR',
        await createRole(mid, team, { name: 'Sneakier', permissions: bits(P.ADMINISTRATOR) }),
      ],
      [
        'reorder the roles above them',
        await t.http
          .put(`/api/teams/${team}/roles/order`)
          .set(mid.auth)
          .send({ ids: [middle.id, boss.id, low.id] }),
      ],
      [
        'move a role above their own',
        await t.http
          .put(`/api/teams/${team}/roles/order`)
          .set(mid.auth)
          .send({ ids: [boss.id, low.id, middle.id] }),
      ],
    ];
    for (const [what, res] of refused) expect(res.status, what).toBe(403);
    expect(await auditCount(team)).toBe(before); // a refused change leaves no trace
    expect((await roleList(owner, team)).map((r) => [r.name, r.position])).toEqual([
      ['Boss', 3],
      ['Mid', 2],
      ['Low', 1],
      ['@everyone', 0],
    ]);

    // what they may do: roles below them, with permissions they hold
    expect(
      (await patchRole(mid, low.id, { permissions: bits(P.EDIT_PAGES, P.VIEW_NOTEBOOKS) })).status,
    ).toBe(200);
    expect((await assign(mid, team, plain.id, low.id)).status).toBe(204);
    const fresh = await createRole(mid, team, { name: 'Fresh', permissions: bits(P.EDIT_PAGES) });
    expect(fresh.status).toBe(201);
    expect(
      (
        await t.http
          .put(`/api/teams/${team}/roles/order`)
          .set(mid.auth)
          .send({ ids: [boss.id, middle.id, fresh.body.id, low.id] })
      ).status,
    ).toBe(200);
    expect((await patchRole(mid, fresh.body.id, { name: 'Fresher' })).status).toBe(200);
    expect((await deleteRole(mid, fresh.body.id)).status).toBe(204);
    expect(await auditCount(team)).toBe(before + 6); // edit, assign, create, reorder, edit, delete: one row each
  });

  it('the owner is above every role; an administrator is not above the roles at their own level', async () => {
    const { team, boss, middle } = await ladder();
    expect((await patchRole(owner, boss.id, { name: 'Chief' })).status).toBe(200);
    expect((await deleteRole(owner, middle.id)).status).toBe(204);

    const adminRole = await role(owner, team, 'Admins', bits(P.ADMINISTRATOR));
    const peer = await role(owner, team, 'Peer admins', bits(P.ADMINISTRATOR));
    await assign(owner, team, other.id, adminRole.id);
    // adminRole is above peer now (created first, so higher)
    expect((await patchRole(other, peer.id, { name: 'Edited' })).status).toBe(200); // below: fine
    expect((await patchRole(other, adminRole.id, { name: 'Own' })).status).toBe(403); // their own
    expect(
      (
        await createRole(other, team, {
          name: 'Anything',
          permissions: bits(P.MANAGE_TEAM, P.MENTION_EVERYONE),
        })
      ).status,
    ).toBe(201); // holds every permission
  });

  it('unassigning respects the hierarchy too', async () => {
    const { team, boss, low } = await ladder();
    await assign(owner, team, other.id, low.id);
    await assign(owner, team, other.id, boss.id);
    expect((await unassign(mid, team, other.id, boss.id)).status).toBe(403);
    expect((await unassign(mid, team, other.id, low.id)).status).toBe(204);
  });

  it('table: outsiders get 404, members without MANAGE_ROLES get 403, the owner succeeds', async () => {
    const team = await newTeam();
    const target = await role(owner, team, 'Target');
    const proj = await project(owner, team);
    await inProject(proj.id, plain);

    const calls: Array<
      [string, (who: Account) => Promise<{ status: number }>, 'member-can-read' | 'manage-only']
    > = [
      ['GET roles', (w) => t.http.get(`/api/teams/${team}/roles`).set(w.auth), 'member-can-read'],
      ['POST roles', (w) => createRole(w, team, { name: 'N' }), 'manage-only'],
      [
        'PUT order',
        async (w) =>
          t.http
            .put(`/api/teams/${team}/roles/order`)
            .set(w.auth)
            .send({
              ids: (await roleList(owner, team)).filter((r) => !r.isEveryone).map((r) => r.id),
            }),
        'manage-only',
      ],
      ['PATCH role', (w) => patchRole(w, target.id, { name: 'Z' }), 'manage-only'],
      ['PUT assign', (w) => assign(w, team, other.id, target.id), 'manage-only'],
      ['DELETE unassign', (w) => unassign(w, team, other.id, target.id), 'manage-only'],
      [
        'GET project roles',
        (w) => t.http.get(`/api/projects/${proj.id}/roles`).set(w.auth),
        'member-can-read',
      ],
      [
        'POST project roles',
        (w) => t.http.post(`/api/projects/${proj.id}/roles`).set(w.auth).send({ name: 'PR' }),
        'manage-only',
      ],
      [
        'GET overwrites',
        (w) => t.http.get('/api/overwrites').set(w.auth).query({ kind: 'project', id: proj.id }),
        'manage-only',
      ],
      [
        'PUT overwrite',
        (w) => setOverwrite(w, overwrite(proj.id, 'member', plain.id, '0', bits(P.EDIT_PAGES))),
        'manage-only',
      ],
      [
        'GET preview',
        (w) =>
          t.http
            .get('/api/permissions/preview')
            .set(w.auth)
            .query({ subject: `member:${plain.id}`, kind: 'team', id: team }),
        'manage-only',
      ],
      ['GET audit', (w) => viewAudit(w, team), 'manage-only'],
    ];
    for (const [name, call, kind] of calls) {
      expect((await call(outsider)).status, `${name}: outsider`).toBe(404);
      const asMember = (await call(plain)).status;
      expect(asMember, `${name}: member`).toBe(kind === 'member-can-read' ? 200 : 403);
      const asOwner = (await call(owner)).status;
      expect([200, 201, 204], `${name}: owner (${asOwner})`).toContain(asOwner);
    }
    expect((await patchRole(outsider, crypto.randomUUID(), { name: 'x' })).status).toBe(404); // unknown role
  });
});

// ------------------------------------------------------------------ @everyone

describe('@everyone', () => {
  it('cannot be deleted, renamed, recoloured or moved; its permissions can be edited', async () => {
    const team = await newTeam();
    const everyone = await everyoneOf(team);
    expect((await deleteRole(owner, everyone.id)).status).toBe(403);
    expect((await patchRole(owner, everyone.id, { name: 'All' })).status).toBe(403);
    expect((await patchRole(owner, everyone.id, { color: '#112233' })).status).toBe(403);
    expect((await patchRole(owner, everyone.id, { hoist: true })).status).toBe(403);
    const reorder = await t.http
      .put(`/api/teams/${team}/roles/order`)
      .set(owner.auth)
      .send({ ids: [everyone.id] });
    expect(reorder.status).toBe(422); // it is not part of the order
    const edited = await patchRole(owner, everyone.id, {
      permissions: bits(P.VIEW_NOTEBOOKS, P.VIEW_CHANNEL, P.EDIT_PAGES),
    });
    expect(edited.status).toBe(200);
    expect(await everyoneOf(team)).toMatchObject({
      name: '@everyone',
      position: 0,
      color: null,
      permissions: P.VIEW_NOTEBOOKS | P.VIEW_CHANNEL | P.EDIT_PAGES,
    });
    expect(can(await meIn(plain, team), P.EDIT_PAGES)).toBe(true);
  });

  it('only the owner may give it ADMINISTRATOR, even an administrator may not', async () => {
    const team = await newTeam();
    const everyone = await everyoneOf(team);
    const adminRole = await role(owner, team, 'Admins', bits(P.ADMINISTRATOR));
    await assign(owner, team, other.id, adminRole.id);
    const before = await auditCount(team);
    const withAdmin = bits(P.VIEW_NOTEBOOKS, P.ADMINISTRATOR);
    expect((await patchRole(other, everyone.id, { permissions: withAdmin })).status).toBe(403);
    expect(await auditCount(team)).toBe(before);
    expect((await patchRole(owner, everyone.id, { permissions: withAdmin })).status).toBe(200);
    expect(can(await meIn(plain, team), P.MANAGE_TEAM)).toBe(true); // everybody is an administrator now
  });
});

// ------------------------------------------------------------------ overwrites (criterion 4, 5)

describe('overwrites', () => {
  const ALL_VIEW = bits(P.VIEW_CHANNEL, P.VIEW_NOTEBOOKS, P.VIEW_BOARDS, P.VIEW_CALENDAR);

  it('allow and deny on the same bit are refused; allowing and denying nothing clears the overwrite', async () => {
    const team = await newTeam();
    const proj = await project(owner, team);
    const everyone = await everyoneOf(team);
    expect(
      (
        await setOverwrite(
          owner,
          overwrite(proj.id, 'role', everyone.id, bits(P.EDIT_PAGES), bits(P.EDIT_PAGES)),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await setOverwrite(
          owner,
          overwrite(
            proj.id,
            'role',
            everyone.id,
            bits(P.EDIT_PAGES),
            bits(P.EDIT_PAGES, P.DELETE_PAGES),
          ),
        )
      ).status,
    ).toBe(400);
    const ok = await setOverwrite(
      owner,
      overwrite(proj.id, 'role', everyone.id, bits(P.EDIT_PAGES), bits(P.DELETE_PAGES)),
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      targetKind: 'project',
      subjectKind: 'role',
      allow: bits(P.EDIT_PAGES),
      deny: bits(P.DELETE_PAGES),
    });
    const listed = await t.http
      .get('/api/overwrites')
      .set(owner.auth)
      .query({ kind: 'project', id: proj.id });
    expect(listed.body).toHaveLength(1);

    const again = await setOverwrite(
      owner,
      overwrite(proj.id, 'role', everyone.id, bits(P.EDIT_PAGES), '0'),
    );
    expect(again.body.id).toBe(ok.body.id); // replaced, not duplicated
    expect(await t.prisma.overwrite.count({ where: { targetId: proj.id } })).toBe(1);
    const cleared = await setOverwrite(owner, overwrite(proj.id, 'role', everyone.id, '0', '0'));
    expect(cleared.status).toBe(200);
    expect(await t.prisma.overwrite.count({ where: { targetId: proj.id } })).toBe(0);
  });

  it('boards have no overwrites yet; the subject must exist in the project', async () => {
    const team = await newTeam();
    const proj = await project(owner, team);
    const channel = {
      ...overwrite(proj.id, 'member', plain.id, '0', bits(P.EDIT_PAGES)),
      targetKind: 'board', // notebooks have overwrites since phase 10 (see sharing.test.ts)
    };
    expect((await setOverwrite(owner, channel)).status).toBe(422);
    expect(
      (
        await setOverwrite(
          owner,
          overwrite(proj.id, 'member', outsider.id, '0', bits(P.EDIT_PAGES)),
        )
      ).status,
    ).toBe(422); // not in the team
    expect(
      (
        await setOverwrite(
          owner,
          overwrite(proj.id, 'role', crypto.randomUUID(), '0', bits(P.EDIT_PAGES)),
        )
      ).status,
    ).toBe(404);
    const foreignTeam = await newTeam();
    const foreignRole = await role(owner, foreignTeam, 'Foreign');
    expect(
      (
        await setOverwrite(
          owner,
          overwrite(proj.id, 'role', foreignRole.id, '0', bits(P.EDIT_PAGES)),
        )
      ).status,
    ).toBe(404);
  });

  it('denying @everyone on a project hides it from the members, and allowing a role brings it back for that role', async () => {
    const team = await newTeam();
    const proj = await project(owner, team);
    for (const who of [plain, other, mid]) await inProject(proj.id, who);
    const dev = await role(owner, team, 'Dev');
    await assign(owner, team, other.id, dev.id);
    const everyone = await everyoneOf(team);

    expect((await t.http.get(`/api/projects/${proj.id}`).set(plain.auth)).status).toBe(200);
    expect(
      (await setOverwrite(owner, overwrite(proj.id, 'role', everyone.id, '0', ALL_VIEW))).status,
    ).toBe(200);
    expect(
      (await setOverwrite(owner, overwrite(proj.id, 'role', dev.id, ALL_VIEW, '0'))).status,
    ).toBe(200);

    expect((await t.http.get(`/api/projects/${proj.id}`).set(plain.auth)).status).toBe(404); // hidden
    expect((await t.http.get(`/api/projects/${proj.id}`).set(other.auth)).status).toBe(200); // Dev sees it
    expect((await t.http.get(`/api/projects/${proj.id}`).set(owner.auth)).status).toBe(200);
    const listed = async (who: Account) =>
      (await t.http.get(`/api/teams/${team}/projects`).set(who.auth)).body.map(
        (p: { id: string }) => p.id,
      );
    expect(await listed(plain)).toEqual([]);
    expect(await listed(other)).toEqual([proj.id]);
    expect(
      Object.keys((await t.http.get(`/api/teams/${team}/me`).set(plain.auth)).body.projects),
    ).toEqual([]);
    // the hidden project's space and notebooks are gone for them as well
    expect((await t.http.get(`/api/spaces/${proj.spaceId}/notebooks`).set(plain.auth)).status).toBe(
      404,
    );
    expect((await t.http.get(`/api/spaces/${proj.spaceId}/notebooks`).set(other.auth)).status).toBe(
      200,
    );
  });

  it('a manager still sees a project that an overwrite hides, so it can always be repaired', async () => {
    const team = await newTeam();
    const proj = await project(owner, team);
    const managers = await role(owner, team, 'Managers', bits(P.MANAGE_PROJECTS, P.VIEW_NOTEBOOKS));
    await assign(owner, team, mid.id, managers.id);
    const everyone = await everyoneOf(team);
    await setOverwrite(owner, overwrite(proj.id, 'role', everyone.id, '0', ALL_VIEW));
    await setOverwrite(owner, overwrite(proj.id, 'role', managers.id, '0', ALL_VIEW));
    expect((await t.http.get(`/api/projects/${proj.id}`).set(mid.auth)).status).toBe(200);
  });

  it('a member allow beats a role deny; a deeper level beats a shallower one', async () => {
    const team = await newTeam();
    const top = await project(owner, team, 'Top');
    const sub = await project(owner, team, 'Sub', top.id);
    for (const who of [plain, other]) {
      await inProject(top.id, who);
      await inProject(sub.id, who);
    }
    const editors = await role(owner, team, 'Editors', bits(P.EDIT_PAGES, P.VIEW_NOTEBOOKS));
    await assign(owner, team, plain.id, editors.id);
    await assign(owner, team, other.id, editors.id);

    // the role is denied EDIT_PAGES on Top, but "plain" is allowed it personally
    await setOverwrite(owner, overwrite(top.id, 'role', editors.id, '0', bits(P.EDIT_PAGES)));
    await setOverwrite(owner, overwrite(top.id, 'member', plain.id, bits(P.EDIT_PAGES), '0'));
    expect(can(await meIn(plain, team, top.id), P.EDIT_PAGES)).toBe(true);
    expect(can(await meIn(other, team, top.id), P.EDIT_PAGES)).toBe(false);
    // the sub-project inherits the overwrites of Top ...
    expect(can(await meIn(plain, team, sub.id), P.EDIT_PAGES)).toBe(true);
    expect(can(await meIn(other, team, sub.id), P.EDIT_PAGES)).toBe(false);
    // ... until a deeper level says otherwise
    await setOverwrite(owner, overwrite(sub.id, 'role', editors.id, bits(P.EDIT_PAGES), '0'));
    expect(can(await meIn(other, team, sub.id), P.EDIT_PAGES)).toBe(true);
    expect(can(await meIn(other, team, top.id), P.EDIT_PAGES)).toBe(false);
  });

  it('you can only allow or deny what you hold in that project, and MANAGE_PROJECTS is required', async () => {
    const team = await newTeam();
    const proj = await project(owner, team);
    await inProject(proj.id, mid);
    await inProject(proj.id, plain);
    const managers = await role(
      owner,
      team,
      'Managers',
      bits(P.MANAGE_PROJECTS, P.VIEW_NOTEBOOKS, P.EDIT_PAGES),
    );
    await assign(owner, team, mid.id, managers.id);
    const everyone = await everyoneOf(team);
    const before = await auditCount(team);

    expect(
      (await setOverwrite(plain, overwrite(proj.id, 'role', everyone.id, '0', bits(P.EDIT_PAGES))))
        .status,
    ).toBe(403); // no MANAGE_PROJECTS
    expect(
      (await setOverwrite(mid, overwrite(proj.id, 'role', everyone.id, bits(P.DELETE_PAGES), '0')))
        .status,
    ).toBe(403); // does not hold it
    expect(
      (await setOverwrite(mid, overwrite(proj.id, 'role', everyone.id, '0', bits(P.DELETE_PAGES))))
        .status,
    ).toBe(403); // not even to deny it
    expect(await auditCount(team)).toBe(before);
    expect(
      (await setOverwrite(mid, overwrite(proj.id, 'role', everyone.id, bits(P.EDIT_PAGES), '0')))
        .status,
    ).toBe(200);
    expect(await auditCount(team)).toBe(before + 1);

    // taking it away again follows the same rules
    const row = await t.prisma.overwrite.findFirstOrThrow({ where: { targetId: proj.id } });
    expect((await t.http.delete(`/api/overwrites/${row.id}`).set(plain.auth)).status).toBe(403);
    expect((await t.http.delete(`/api/overwrites/${row.id}`).set(outsider.auth)).status).toBe(404);
    expect((await t.http.delete(`/api/overwrites/${row.id}`).set(mid.auth)).status).toBe(204);
    expect(await t.prisma.overwrite.count({ where: { targetId: proj.id } })).toBe(0);
  });

  it('deleting a role takes it off its members and out of every overwrite, together', async () => {
    const team = await newTeam();
    const proj = await project(owner, team);
    await inProject(proj.id, plain);
    const doomed = await role(owner, team, 'Doomed', bits(P.EDIT_PAGES));
    const keeper = await role(owner, team, 'Keeper');
    await assign(owner, team, plain.id, doomed.id);
    await assign(owner, team, other.id, doomed.id);
    await assign(owner, team, plain.id, keeper.id);
    await setOverwrite(owner, overwrite(proj.id, 'role', doomed.id, bits(P.DELETE_PAGES), '0'));
    await setOverwrite(owner, overwrite(proj.id, 'role', keeper.id, bits(P.DELETE_PAGES), '0'));
    expect(can(await meIn(plain, team, proj.id), P.EDIT_PAGES)).toBe(true);

    expect((await deleteRole(owner, doomed.id)).status).toBe(204);
    expect(await t.prisma.memberRole.count({ where: { roleId: doomed.id } })).toBe(0);
    expect(await t.prisma.overwrite.count({ where: { subjectId: doomed.id } })).toBe(0);
    expect(await t.prisma.overwrite.count({ where: { subjectId: keeper.id } })).toBe(1); // the other one stays
    expect(await t.prisma.memberRole.count({ where: { roleId: keeper.id } })).toBe(1);
    expect(can(await meIn(plain, team, proj.id), P.EDIT_PAGES)).toBe(false);
  });
});

// ------------------------------------------------------------------ project roles

describe('project roles', () => {
  it('apply inside their project and below, not elsewhere, and only to members of the project', async () => {
    const team = await newTeam();
    const top = await project(owner, team, 'Top');
    const sub = await project(owner, team, 'Sub', top.id);
    const sibling = await project(owner, team, 'Sibling');
    for (const who of [plain, other])
      for (const p of [top, sub, sibling]) await inProject(p.id, who);

    const create = await t.http
      .post(`/api/projects/${top.id}/roles`)
      .set(owner.auth)
      .send({ name: 'Lead', permissions: bits(P.EDIT_PAGES) });
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({ projectId: top.id, name: 'Lead' });
    const lead = create.body as Role;

    // not a member of the project: refused (422), and a team-level assign cannot give it either
    expect(
      (
        await t.http
          .put(`/api/projects/${top.id}/members/${outsider.id}/roles/${lead.id}`)
          .set(owner.auth)
      ).status,
    ).toBe(422);
    expect(
      (
        await t.http
          .put(`/api/projects/${top.id}/members/${mid.id}/roles/${lead.id}`)
          .set(owner.auth)
      ).status,
    ).toBe(422); // in the team, not the project
    expect((await assign(owner, team, plain.id, lead.id)).status).toBe(404);
    expect(
      (
        await t.http
          .put(`/api/projects/${top.id}/members/${plain.id}/roles/${lead.id}`)
          .set(owner.auth)
      ).status,
    ).toBe(204);

    expect(can(await meIn(plain, team, top.id), P.EDIT_PAGES)).toBe(true);
    expect(can(await meIn(plain, team, sub.id), P.EDIT_PAGES)).toBe(true); // below
    expect(can(await meIn(plain, team, sibling.id), P.EDIT_PAGES)).toBe(false); // elsewhere
    expect(can(await meIn(plain, team), P.EDIT_PAGES)).toBe(false); // not at team level
    expect(can(await meIn(other, team, top.id), P.EDIT_PAGES)).toBe(false); // somebody else

    // listed with the project, and with its sub-projects (the roles that can be used there), not at team level
    const inTop = (await t.http.get(`/api/projects/${top.id}/roles`).set(owner.auth))
      .body as Role[];
    const inSub = (await t.http.get(`/api/projects/${sub.id}/roles`).set(owner.auth))
      .body as Role[];
    const inSibling = (await t.http.get(`/api/projects/${sibling.id}/roles`).set(owner.auth))
      .body as Role[];
    expect(inTop.map((r) => r.name)).toEqual(['Lead']);
    expect(inSub.map((r) => r.name)).toEqual(['Lead']);
    expect(inSibling).toEqual([]);
    expect((await roleList(owner, team)).map((r) => r.name)).toEqual(['@everyone']);
    const projectMembers = await t.http.get(`/api/projects/${top.id}/members`).set(owner.auth);
    expect(
      projectMembers.body.find((m: { userId: string }) => m.userId === plain.id).roleIds,
    ).toEqual([lead.id]);

    // taking the person out of the project takes the role with them
    expect(
      (await t.http.delete(`/api/projects/${top.id}/members/${plain.id}`).set(owner.auth)).status,
    ).toBe(204);
    expect(await t.prisma.memberRole.count({ where: { roleId: lead.id } })).toBe(0);
  });

  it('can be used in overwrites of their project and below, not of other projects', async () => {
    const team = await newTeam();
    const top = await project(owner, team, 'Top');
    const sub = await project(owner, team, 'Sub', top.id);
    const sibling = await project(owner, team, 'Sibling');
    const lead = (
      await t.http.post(`/api/projects/${top.id}/roles`).set(owner.auth).send({ name: 'Lead' })
    ).body as Role;
    expect(
      (await setOverwrite(owner, overwrite(sub.id, 'role', lead.id, bits(P.EDIT_PAGES), '0')))
        .status,
    ).toBe(200);
    expect(
      (await setOverwrite(owner, overwrite(sibling.id, 'role', lead.id, bits(P.EDIT_PAGES), '0')))
        .status,
    ).toBe(404);
  });

  it('the hierarchy applies inside a project as well, and team roles count for the rank', async () => {
    const team = await newTeam();
    const proj = await project(owner, team);
    await inProject(proj.id, mid);
    await inProject(proj.id, plain);
    const post = (who: Account, body: object) =>
      t.http.post(`/api/projects/${proj.id}/roles`).set(who.auth).send(body);
    const high = (
      await post(owner, { name: 'High', permissions: bits(P.MANAGE_ROLES, P.EDIT_PAGES) })
    ).body as Role;
    const low = (await post(owner, { name: 'Low', permissions: bits(P.EDIT_PAGES) })).body as Role;
    await t.http.put(`/api/projects/${proj.id}/members/${mid.id}/roles/${high.id}`).set(owner.auth);

    const put = (roleId: string) =>
      t.http.put(`/api/projects/${proj.id}/members/${plain.id}/roles/${roleId}`).set(mid.auth);
    expect((await put(high.id)).status).toBe(403); // their own role
    expect((await put(low.id)).status).toBe(204); // below
    expect((await post(mid, { name: 'X', permissions: bits(P.DELETE_PAGES) })).status).toBe(403); // not held
    expect((await post(plain, { name: 'Y' })).status).toBe(403); // no MANAGE_ROLES
  });

  it('deleting the project deletes its roles and overwrites', async () => {
    const team = await newTeam();
    const top = await project(owner, team, 'Top');
    const sub = await project(owner, team, 'Sub', top.id);
    await inProject(top.id, plain);
    const lead = (
      await t.http.post(`/api/projects/${top.id}/roles`).set(owner.auth).send({ name: 'Lead' })
    ).body as Role;
    const subRole = (
      await t.http.post(`/api/projects/${sub.id}/roles`).set(owner.auth).send({ name: 'SubLead' })
    ).body as Role;
    await t.http
      .put(`/api/projects/${top.id}/members/${plain.id}/roles/${lead.id}`)
      .set(owner.auth);
    await setOverwrite(owner, overwrite(top.id, 'member', plain.id, bits(P.EDIT_PAGES), '0'));
    await setOverwrite(owner, overwrite(sub.id, 'role', lead.id, bits(P.EDIT_PAGES), '0'));
    const keep = await role(owner, team, 'Team role');

    expect((await t.http.delete(`/api/projects/${top.id}`).set(owner.auth)).status).toBe(204);
    expect(await t.prisma.role.count({ where: { id: { in: [lead.id, subRole.id] } } })).toBe(0);
    expect(await t.prisma.memberRole.count({ where: { roleId: lead.id } })).toBe(0);
    expect(await t.prisma.overwrite.count({ where: { targetId: { in: [top.id, sub.id] } } })).toBe(
      0,
    );
    expect(await t.prisma.role.count({ where: { id: keep.id } })).toBe(1);
  });

  it('removing a person from the team removes their roles and their personal overwrites', async () => {
    const team = await newTeam();
    const proj = await project(owner, team);
    await inProject(proj.id, plain);
    const r = await role(owner, team, 'R');
    await assign(owner, team, plain.id, r.id);
    await setOverwrite(owner, overwrite(proj.id, 'member', plain.id, bits(P.EDIT_PAGES), '0'));
    expect(
      (await t.http.delete(`/api/teams/${team}/members/${plain.id}`).set(owner.auth)).status,
    ).toBe(204);
    expect(await t.prisma.memberRole.count({ where: { userId: plain.id } })).toBe(0);
    expect(await t.prisma.overwrite.count({ where: { subjectId: plain.id } })).toBe(0);
  });
});

// ------------------------------------------------------------------ audit log (criterion 6)

describe('the audit log', () => {
  it('each mutation writes exactly one row, with who, what and before/after', async () => {
    const team = await newTeam();
    const base = await auditCount(team);
    expect(base).toBe(1); // team.create by the instance admin

    const r = await role(owner, team, 'Reviewer', bits(P.EDIT_PAGES));
    await patchRole(owner, r.id, {
      name: 'Senior',
      permissions: bits(P.EDIT_PAGES, P.DELETE_PAGES),
    });
    await assign(owner, team, plain.id, r.id);
    await unassign(owner, team, plain.id, r.id);
    const proj = await project(owner, team);
    await inProject(proj.id, plain);
    const everyone = await everyoneOf(team);
    await setOverwrite(owner, overwrite(proj.id, 'role', everyone.id, '0', bits(P.EDIT_PAGES)));
    await setOverwrite(
      owner,
      overwrite(proj.id, 'role', everyone.id, '0', bits(P.EDIT_PAGES, P.DELETE_PAGES)),
    );
    await setOverwrite(owner, overwrite(proj.id, 'role', everyone.id, '0', '0'));
    await deleteRole(owner, r.id);
    await t.http
      .patch(`/api/teams/${team}/members/${plain.id}`)
      .set(owner.auth)
      .send({ nickname: 'Plainy' });
    await t.http.patch(`/api/teams/${team}`).set(owner.auth).send({ name: 'Rocket 2' });
    await t.http.delete(`/api/teams/${team}/members/${other.id}`).set(owner.auth);

    const rows = await auditRows(team);
    expect(rows.map((x) => x.action)).toEqual([
      'team.create',
      'role.create',
      'role.update',
      'role.assign',
      'role.unassign',
      'project.create',
      'overwrite.set',
      'overwrite.set',
      'overwrite.clear',
      'role.delete',
      'member.nickname',
      'team.update',
      'member.remove',
    ]);
    const by = (action: string, n = 0) => rows.filter((x) => x.action === action)[n]!;
    expect(by('team.create').actorId).toBe(admin.id);
    expect(by('role.create')).toMatchObject({
      actorId: owner.id,
      targetKind: 'role',
      targetId: r.id,
      before: null,
    });
    expect(by('role.create').after).toMatchObject({
      name: 'Reviewer',
      permissions: bits(P.EDIT_PAGES),
    });
    expect(by('role.update').before).toEqual({ name: 'Reviewer', permissions: bits(P.EDIT_PAGES) });
    expect(by('role.update').after).toEqual({
      name: 'Senior',
      permissions: bits(P.EDIT_PAGES, P.DELETE_PAGES),
    });
    expect(by('role.assign')).toMatchObject({ targetKind: 'member', targetId: plain.id });
    expect(by('role.assign').after).toMatchObject({ roleId: r.id, roleName: 'Senior' });
    expect(by('overwrite.set', 0)).toMatchObject({
      targetKind: 'project',
      targetId: proj.id,
      before: null,
    });
    expect(by('overwrite.set', 1).before).toMatchObject({ deny: bits(P.EDIT_PAGES) });
    expect(by('overwrite.set', 1).after).toMatchObject({
      deny: bits(P.EDIT_PAGES, P.DELETE_PAGES),
      subjectName: '@everyone',
    });
    expect(by('overwrite.clear').before).toMatchObject({
      deny: bits(P.EDIT_PAGES, P.DELETE_PAGES),
    });
    expect(by('role.delete').before).toMatchObject({ name: 'Senior', memberCount: 0 });
    expect(by('member.nickname').after).toEqual({ nickname: 'Plainy' });
    expect(by('team.update').after).toEqual({ name: 'Rocket 2' });
    expect(by('member.remove')).toMatchObject({ actorId: owner.id, targetId: other.id });
  });

  it('a mutation that fails writes no row and leaves no half-done change (the transaction rolls back)', async () => {
    const team = await newTeam();
    const proj = await project(owner, team);
    await t.prisma.team.update({ where: { id: team }, data: { ownerId: null } }); // the owner account is gone
    const lone = await t.prisma.role.create({
      data: {
        id: crypto.randomUUID(),
        teamId: team,
        name: 'Admins',
        position: 3,
        permissions: P.ADMINISTRATOR,
      },
    });
    const above = await t.prisma.role.create({
      data: {
        id: crypto.randomUUID(),
        teamId: team,
        name: 'Above',
        position: 9,
        permissions: P.MANAGE_ROLES,
      },
    });
    await t.prisma.memberRole.create({ data: { userId: mid.id, roleId: lone.id } });
    await t.prisma.memberRole.create({ data: { userId: plain.id, roleId: above.id } });
    await t.prisma.overwrite.create({
      data: {
        id: crypto.randomUUID(),
        targetKind: 'project',
        targetId: proj.id,
        subjectKind: 'role',
        subjectId: lone.id,
        allow: P.EDIT_PAGES,
        deny: 0n,
      },
    });
    const before = await auditCount(team);

    // "plain" outranks the Admins role, so the hierarchy allows deleting it; but it is the last administrator role
    const res = await deleteRole(plain, lone.id);
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('last_administrator');
    expect(await auditCount(team)).toBe(before);
    expect(await t.prisma.role.count({ where: { id: lone.id } })).toBe(1);
    expect(await t.prisma.memberRole.count({ where: { roleId: lone.id } })).toBe(1);
    expect(await t.prisma.overwrite.count({ where: { subjectId: lone.id } })).toBe(1); // deleted first inside the transaction, restored by the rollback
  });

  it('the viewer needs VIEW_AUDIT_LOG: 404 outside the team, 403 inside without it', async () => {
    const team = await newTeam();
    expect((await viewAudit(outsider, team)).status).toBe(404);
    expect((await viewAudit(plain, team)).status).toBe(403);
    expect((await viewAudit(owner, team)).status).toBe(200);
    await allowAudit(team, plain);
    const res = await viewAudit(plain, team);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      action: 'role.assign',
      actorId: owner.id,
      actorName: 'Test',
    });
  });

  it('filters by action, actor and date, and pages through the history, newest first', async () => {
    const team = await newTeam();
    for (let i = 0; i < 5; i++) await role(owner, team, `R${i}`);
    await t.prisma.role.findMany({ where: { teamId: team } });
    const all = (await viewAudit(owner, team, { limit: 100 })).body;
    expect(all.items.map((e: { action: string }) => e.action)).toEqual([
      ...Array(5).fill('role.create'),
      'team.create',
    ]);
    expect(all.nextCursor).toBeNull();

    const page1 = (await viewAudit(owner, team, { limit: 2 })).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await viewAudit(owner, team, { limit: 2, cursor: page1.nextCursor })).body;
    const page3 = (await viewAudit(owner, team, { limit: 2, cursor: page2.nextCursor })).body;
    expect(
      [...page1.items, ...page2.items, ...page3.items].map((e: { id: string }) => e.id),
    ).toEqual(all.items.map((e: { id: string }) => e.id));
    expect(page3.nextCursor).toBeNull();

    expect((await viewAudit(owner, team, { action: 'team.create' })).body.items).toHaveLength(1);
    expect(
      (await viewAudit(owner, team, { actor: admin.id })).body.items.map(
        (e: { action: string }) => e.action,
      ),
    ).toEqual(['team.create']);
    expect((await viewAudit(owner, team, { actor: owner.id })).body.items).toHaveLength(5);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await viewAudit(owner, team, { from: future })).body.items).toHaveLength(0);
    expect((await viewAudit(owner, team, { to: future })).body.items).toHaveLength(6);
    expect((await viewAudit(owner, team, { limit: 0 })).status).toBe(400);
  });

  it('is append-only: there is no endpoint to change or delete a row, and retention removes only old ones', async () => {
    const team = await newTeam();
    const rows = await auditRows(team);
    for (const method of ['put', 'patch', 'delete', 'post'] as const)
      expect(
        (await t.http[method](`/api/teams/${team}/audit/${rows[0]!.id}`).set(owner.auth).send({}))
          .status,
      ).toBe(404);
    expect((await t.http.delete(`/api/teams/${team}/audit`).set(owner.auth)).status).toBe(404);

    await t.prisma.auditLog.create({
      data: {
        teamId: team,
        actorId: owner.id,
        action: 'role.create',
        targetKind: 'role',
        targetId: 'old',
        createdAt: new Date(Date.now() - 400 * 86_400_000),
      },
    });
    const removed = await t.app.get(AuditService).purge();
    expect(removed).toBe(1);
    expect(await auditCount(team)).toBe(rows.length);
    expect(typeof t.app.get(MaintenanceService).nightly).toBe('function'); // the trash job is unaffected
  });

  it('records team deletion, project changes and quota overrides', async () => {
    const team = await newTeam();
    const proj = await project(owner, team, 'Alpha');
    await inProject(proj.id, plain);
    await t.http.patch(`/api/projects/${proj.id}`).set(owner.auth).send({ name: 'Beta' });
    await t.http.patch(`/api/projects/${proj.id}`).set(owner.auth).send({ position: 'a5' }); // not worth a row
    const second = await project(owner, team, 'Second');
    await t.http
      .post(`/api/projects/${second.id}/move`)
      .set(owner.auth)
      .send({ parentId: proj.id });
    await t.http
      .post(`/api/projects/${proj.id}/members`)
      .set(owner.auth)
      .send({ userId: other.id });
    await t.http.delete(`/api/projects/${proj.id}/members/${other.id}`).set(owner.auth);
    await t.http
      .put(`/api/admin/quotas/team/${team}`)
      .set(admin.auth)
      .send({ storageBytes: 1000, note: 'bigger' });
    await t.http.delete(`/api/projects/${second.id}`).set(owner.auth);
    expect((await t.http.delete(`/api/admin/teams/${team}`).set(admin.auth)).status).toBe(204);

    const actions = (await auditRows(team)).map((r) => r.action);
    expect(actions).toEqual([
      'team.create',
      'project.create',
      'project.update',
      'project.create',
      'project.move',
      'project.member.add',
      'project.member.remove',
      'quota.override',
      'project.delete',
      'team.delete',
    ]);
  });
});

// ------------------------------------------------------------------ last administrator and the owner (criterion 7)

describe('self-lockout protection', () => {
  it('the owner cannot be removed from the team, nor leave without transferring', async () => {
    const team = await newTeam();
    expect(
      (await t.http.delete(`/api/teams/${team}/members/${owner.id}`).set(owner.auth)).status,
    ).toBe(422);
    const adminRole = await role(owner, team, 'Admins', bits(P.ADMINISTRATOR, P.MANAGE_MEMBERS));
    await assign(owner, team, mid.id, adminRole.id);
    expect(
      (await t.http.delete(`/api/teams/${team}/members/${owner.id}`).set(mid.auth)).status,
    ).toBe(422);
    expect(await t.prisma.teamMember.count({ where: { teamId: team, userId: owner.id } })).toBe(1);
  });

  it('when the owner account is gone, the last administrator cannot leave, lose the role, or have it deleted', async () => {
    const team = await newTeam();
    const adminRole = await role(owner, team, 'Admins', bits(P.ADMINISTRATOR));
    await assign(owner, team, mid.id, adminRole.id);
    await t.prisma.team.update({ where: { id: team }, data: { ownerId: null } }); // what deleting the owner's account does

    expect((await t.http.delete(`/api/teams/${team}/members/${mid.id}`).set(mid.auth)).status).toBe(
      422,
    ); // leaving
    expect(await t.prisma.teamMember.count({ where: { teamId: team, userId: mid.id } })).toBe(1);
    expect(await t.prisma.memberRole.count({ where: { roleId: adminRole.id } })).toBe(1);

    // a second administrator makes it possible again
    const second = await t.prisma.role.create({
      data: {
        id: crypto.randomUUID(),
        teamId: team,
        name: 'More admins',
        position: 1,
        permissions: P.ADMINISTRATOR,
      },
    });
    await t.prisma.memberRole.create({ data: { userId: other.id, roleId: second.id } });
    expect((await t.http.delete(`/api/teams/${team}/members/${mid.id}`).set(mid.auth)).status).toBe(
      204,
    );
    // and now `other` is the last one
    expect(
      (await t.http.delete(`/api/teams/${team}/members/${other.id}`).set(other.auth)).status,
    ).toBe(422);
  });

  it('nobody can strip ADMINISTRATOR from @everyone when that would leave no administrator', async () => {
    const team = await newTeam();
    const everyone = await everyoneOf(team);
    await patchRole(owner, everyone.id, { permissions: bits(P.ADMINISTRATOR, P.VIEW_NOTEBOOKS) }); // owner: everybody is an administrator
    await t.prisma.team.update({ where: { id: team }, data: { ownerId: null } });
    await t.prisma.teamMember.deleteMany({
      where: { teamId: team, userId: { notIn: [plain.id] } },
    });
    const mod = await t.prisma.role.create({
      data: {
        id: crypto.randomUUID(),
        teamId: team,
        name: 'Mod',
        position: 1,
        permissions: P.MANAGE_ROLES,
      },
    });
    await t.prisma.memberRole.create({ data: { userId: plain.id, roleId: mod.id } });
    const res = await patchRole(plain, everyone.id, { permissions: bits(P.VIEW_NOTEBOOKS) });
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('last_administrator');
    expect((await everyoneOf(team)).permissions).toBe(P.ADMINISTRATOR | P.VIEW_NOTEBOOKS);
  });
});

// ------------------------------------------------------------------ "view as" (criterion 2, server side)

describe('the permission preview', () => {
  const preview = (who: Account, q: object) =>
    t.http.get('/api/permissions/preview').set(who.auth).query(q);

  it('names the deciding rule for every permission, and agrees with what the member actually gets', async () => {
    const team = await newTeam();
    const proj = await project(owner, team, 'Apollo');
    await inProject(proj.id, plain);
    const dev = await role(owner, team, 'Dev', bits(P.EDIT_PAGES, P.VIEW_BOARDS, P.CREATE_TASKS));
    await assign(owner, team, plain.id, dev.id);
    const everyone = await everyoneOf(team);
    await setOverwrite(owner, overwrite(proj.id, 'role', everyone.id, '0', bits(P.VIEW_NOTEBOOKS)));
    await setOverwrite(owner, overwrite(proj.id, 'role', dev.id, bits(P.VIEW_NOTEBOOKS), '0'));
    await setOverwrite(owner, overwrite(proj.id, 'member', plain.id, '0', bits(P.CREATE_TASKS)));

    const res = await preview(owner, {
      subject: `member:${plain.id}`,
      kind: 'project',
      id: proj.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.subject).toEqual({ kind: 'member', id: plain.id, name: 'Test' });
    expect(permissionsFromString(res.body.permissions)).toBe(await meIn(plain, team, proj.id));
    expect(res.body.names).toMatchObject({
      [dev.id]: 'Dev',
      [proj.id]: 'Apollo',
      [everyone.id]: '@everyone',
    });

    const decision = (name: string) =>
      res.body.decisions.find((d: { permission: string }) => d.permission === name);
    expect(res.body.decisions).toHaveLength(39);
    expect(decision('VIEW_NOTEBOOKS')).toMatchObject({
      granted: true,
      reason: {
        kind: 'overwrite',
        level: proj.id,
        subject: 'roles',
        roleIds: [dev.id],
        effect: 'allow',
      },
    });
    expect(decision('CREATE_TASKS')).toMatchObject({
      granted: false,
      reason: { kind: 'overwrite', level: proj.id, subject: 'member', effect: 'deny' },
    });
    expect(decision('EDIT_PAGES')).toMatchObject({
      granted: true,
      reason: { kind: 'base', everyone: false, roleIds: [dev.id] },
    });
    expect(decision('MANAGE_TEAM')).toMatchObject({ granted: false, reason: { kind: 'none' } });

    // as a role (somebody who holds exactly that role)
    const asRole = await preview(owner, {
      subject: `role:${dev.id}`,
      kind: 'project',
      id: proj.id,
    });
    expect(asRole.status).toBe(200);
    expect(
      asRole.body.decisions.find((d: { permission: string }) => d.permission === 'CREATE_TASKS'),
    ).toMatchObject({ granted: true }); // no member overwrite for a role
    // as @everyone: the deny hides notebooks
    const asEveryone = await preview(owner, {
      subject: `role:${everyone.id}`,
      kind: 'project',
      id: proj.id,
    });
    expect(
      asEveryone.body.decisions.find(
        (d: { permission: string }) => d.permission === 'VIEW_NOTEBOOKS',
      ),
    ).toMatchObject({
      granted: false,
      reason: { kind: 'overwrite', subject: 'everyone', effect: 'deny' },
    });
    expect(
      asEveryone.body.decisions.find((d: { permission: string }) => d.permission === 'EDIT_PAGES'),
    ).toMatchObject({ granted: false });
    // the owner and an administrator hold everything
    const asOwner = await preview(owner, { subject: `member:${owner.id}`, kind: 'team', id: team });
    expect(
      asOwner.body.decisions.every(
        (d: { granted: boolean; reason: { kind: string } }) =>
          d.granted && d.reason.kind === 'owner',
      ),
    ).toBe(true);
    expect(permissionsFromString(asOwner.body.permissions)).toBe(ALL_PERMISSIONS);
  });

  it('answers 404 for subjects that are not part of the team, and for malformed queries 400', async () => {
    const team = await newTeam();
    const proj = await project(owner, team);
    expect(
      (await preview(owner, { subject: `member:${outsider.id}`, kind: 'team', id: team })).status,
    ).toBe(404);
    expect(
      (await preview(owner, { subject: `role:${crypto.randomUUID()}`, kind: 'team', id: team }))
        .status,
    ).toBe(404);
    const otherRole = await role(owner, await newTeam(), 'Elsewhere');
    expect(
      (await preview(owner, { subject: `role:${otherRole.id}`, kind: 'project', id: proj.id }))
        .status,
    ).toBe(404);
    expect((await preview(owner, { subject: 'everyone', kind: 'team', id: team })).status).toBe(
      400,
    );
  });
});

// ------------------------------------------------------------------ nicknames

describe('nicknames', () => {
  it('people set their own; changing somebody else needs MANAGE_MEMBERS', async () => {
    const team = await newTeam();
    const set = (who: Account, target: Account, nickname: string | null) =>
      t.http.patch(`/api/teams/${team}/members/${target.id}`).set(who.auth).send({ nickname });
    expect((await set(plain, plain, 'Plainy')).status).toBe(204);
    expect((await set(plain, other, 'Hacked')).status).toBe(403);
    expect((await set(outsider, plain, 'x')).status).toBe(404);
    expect((await set(owner, outsider, 'x')).status).toBe(404); // not a member
    expect((await set(owner, other, 'Otherly')).status).toBe(204);
    const members = (await t.http.get(`/api/teams/${team}/members`).set(plain.auth)).body as Array<{
      userId: string;
      nickname: string | null;
    }>;
    expect(members.find((m) => m.userId === plain.id)!.nickname).toBe('Plainy');
    expect(members.find((m) => m.userId === other.id)!.nickname).toBe('Otherly');
    expect((await set(plain, plain, '  ')).status).toBe(204); // blank removes it
    expect(
      (await t.http.get(`/api/teams/${team}/members`).set(plain.auth)).body.find(
        (m: { userId: string }) => m.userId === plain.id,
      ).nickname,
    ).toBeNull();
  });
});
