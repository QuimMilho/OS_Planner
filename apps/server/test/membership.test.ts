import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionsToString, Permission } from '@os-planner/shared';
import { createTestApp, GOOD_PASSWORD, uniqueEmail, type TestApp } from './app.js';
import { signup, uuid, type Account } from './helpers.js';

const P = Permission;
const ADMIN_EMAIL = `join-admin${Date.now()}@example.com`;
const DAY = 24 * 60 * 60 * 1000;

let t: TestApp;
let saved: string | undefined;
let admin: Account;
let owner: Account;
let plain: Account;
let visitor: Account;
let other: Account;

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
  t.mail.sent = [];
  admin = await signup(t, true, ADMIN_EMAIL);
  owner = await signup(t);
  plain = await signup(t);
  visitor = await signup(t);
  other = await signup(t);
});

// ------------------------------------------------------------------ helpers

const bits = (...b: bigint[]): string => permissionsToString(b.reduce((a, x) => a | x, 0n));

interface TeamInfo {
  id: string;
  slug: string;
}

async function newTeam(
  extra: object = {},
  ownerEmail = owner.email,
  members: Account[] = [plain],
): Promise<TeamInfo> {
  const res = await t.http
    .post('/api/admin/teams')
    .set(admin.auth)
    .send({ name: 'Rocket', ownerEmail, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const who of members)
    await t.prisma.teamMember.create({ data: { teamId: res.body.id, userId: who.id } });
  return res.body as TeamInfo;
}

const invite = (who: Account, teamId: string, body: object) =>
  t.http.post(`/api/teams/${teamId}/invites`).set(who.auth).send(body);
const accept = (who: Account, token: string) =>
  t.http.post('/api/invites/accept').set(who.auth).send({ token });
const tokenOf = (url: string): string => decodeURIComponent(url.split('/invite/')[1]!);
const link = async (who: Account, teamId: string, body: object = {}) => {
  const res = await invite(who, teamId, { link: true, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.id as string, token: tokenOf(res.body.url as string) };
};
const isMember = async (teamId: string, who: Account) =>
  (await t.prisma.teamMember.count({ where: { teamId, userId: who.id } })) === 1;
/** The verification mail is sent without the request waiting for it, so wait until it has arrived. */
const verifyToken = (email: string) =>
  vi.waitFor(() => {
    const m = t.mail.last('verify', email);
    if (!m) throw new Error('no mail yet');
    return m.token;
  });
const audit = (teamId: string, action: string) =>
  t.prisma.auditLog.findMany({ where: { teamId, action } });

/** Makes a role with the given permissions, held by `who`. */
async function grant(teamId: string, who: Account, ...perms: bigint[]): Promise<string> {
  const res = await t.http
    .post(`/api/teams/${teamId}/roles`)
    .set(owner.auth)
    .send({ name: 'Helper', permissions: bits(...perms) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const put = await t.http
    .put(`/api/teams/${teamId}/members/${who.id}/roles/${res.body.id}`)
    .set(owner.auth);
  expect(put.status, JSON.stringify(put.body)).toBe(204);
  return res.body.id as string;
}

// ------------------------------------------------------------------ invites

describe('link invites', () => {
  it('allows as many uses as it says, then answers like an unknown token', async () => {
    const team = await newTeam();
    const { token } = await link(owner, team.id, { maxUses: 2 });
    const third = await signup(t);

    expect((await accept(visitor, token)).body).toEqual({ teamId: team.id, joined: true });
    expect((await accept(other, token)).status).toBe(200);
    const refused = await accept(third, token);
    expect(refused.status).toBe(404);
    expect(refused.body.message).toBe('invalid_invite');
    expect(await isMember(team.id, third)).toBe(false);

    const row = await t.prisma.invite.findFirstOrThrow({ where: { teamId: team.id } });
    expect(row.uses).toBe(2);
    expect(await audit(team.id, 'invite.create')).toHaveLength(1);
    expect(await audit(team.id, 'member.add')).toHaveLength(2);
  });

  it('never goes over maxUses when many accept at once', async () => {
    const team = await newTeam();
    const { token } = await link(owner, team.id, { maxUses: 3 });
    const crowd = await Promise.all(Array.from({ length: 8 }, () => signup(t)));
    const results = await Promise.all(crowd.map((w) => accept(w, token)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 404)).toHaveLength(5);
    expect((await t.prisma.invite.findFirstOrThrow({ where: { teamId: team.id } })).uses).toBe(3);
    expect(await t.prisma.teamMember.count({ where: { teamId: team.id } })).toBe(1 + 1 + 3); // owner, plain, three
  });

  it('is idempotent for somebody already in: nothing is used up', async () => {
    const team = await newTeam();
    const { token } = await link(owner, team.id, { maxUses: 1 });
    expect((await accept(plain, token)).body).toEqual({ teamId: team.id, joined: false });
    expect((await t.prisma.invite.findFirstOrThrow({ where: { teamId: team.id } })).uses).toBe(0);
    expect((await accept(visitor, token)).body.joined).toBe(true);
  });

  it('gives the roles it carries, and only those its creator may hand out', async () => {
    const team = await newTeam();
    const role = await t.http
      .post(`/api/teams/${team.id}/roles`)
      .set(owner.auth)
      .send({ name: 'Dev', permissions: bits(P.EDIT_PAGES) });
    const { token } = await link(owner, team.id, { roleIds: [role.body.id] });
    await accept(visitor, token);
    expect(
      await t.prisma.memberRole.count({ where: { userId: visitor.id, roleId: role.body.id } }),
    ).toBe(1);

    // a member who may invite but not manage roles cannot attach one
    await grant(team.id, plain, P.CREATE_INVITES);
    expect((await invite(plain, team.id, { link: true, roleIds: [role.body.id] })).status).toBe(
      403,
    );
    expect((await invite(plain, team.id, { link: true })).status).toBe(201);
    // a role of another team (or @everyone, or nothing) is not a role
    const everyone = await t.prisma.role.findFirstOrThrow({
      where: { teamId: team.id, isEveryone: true },
    });
    expect((await invite(owner, team.id, { link: true, roleIds: [everyone.id] })).status).toBe(422);
    expect((await invite(owner, team.id, { link: true, roleIds: [uuid()] })).status).toBe(422);
  });

  it('puts the person in a project when it names one (top level only)', async () => {
    const team = await newTeam();
    const mk = (body: object) =>
      t.http.post(`/api/teams/${team.id}/projects`).set(owner.auth).send(body);
    const p = await mk({ name: 'Apollo', position: 'a0' });
    const sub = await mk({ name: 'Sub', position: 'a0', parentId: p.body.id });
    const { token } = await link(owner, team.id, { projectId: p.body.id });
    await accept(visitor, token);
    expect(
      await t.prisma.projectMember.count({ where: { projectId: p.body.id, userId: visitor.id } }),
    ).toBe(1);
    expect((await invite(owner, team.id, { link: true, projectId: sub.body.id })).status).toBe(422);
  });

  it('expires after a week unless told otherwise, and an email invite after two', async () => {
    const team = await newTeam();
    const a = await invite(owner, team.id, { link: true });
    const b = await invite(owner, team.id, { email: 'someone@example.com' });
    const days = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / DAY);
    expect(days(a.body.expiresAt)).toBe(7);
    expect(days(b.body.expiresAt)).toBe(14);
    expect((await invite(owner, team.id, { link: true, expiresInDays: 500 })).status).toBe(400);
    expect((await invite(owner, team.id, { email: 'a@example.com', link: true })).status).toBe(400);
    expect((await invite(owner, team.id, {})).status).toBe(400);
  });

  it('answers a stranger with the name, icon and size of the team and nothing else', async () => {
    const team = await newTeam();
    await t.http.patch(`/api/teams/${team.id}`).set(owner.auth).send({ icon: 'rocket' });
    const { token } = await link(owner, team.id);
    const res = await t.http.get('/api/invites/preview').query({ token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ teamName: 'Rocket', icon: 'rocket', color: null, memberCount: 2 });
    expect(JSON.stringify(res.body)).not.toContain(owner.email);
  });
});

describe('invalid invites all look the same', () => {
  it('unknown, expired, revoked and used tokens give one status and one body', async () => {
    const team = await newTeam();
    const mine = await link(owner, team.id);
    const expired = await link(owner, team.id);
    await t.prisma.invite.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const revoked = await link(owner, team.id);
    expect((await t.http.delete(`/api/invites/${revoked.id}`).set(owner.auth)).status).toBe(204);
    const mail = await invite(owner, team.id, { email: other.email });
    const used = t.mail.last('invite', other.email)!.token;
    expect((await accept(other, used)).status).toBe(200);
    expect(mail.status).toBe(201);
    const unknown = 'x'.repeat(43);

    const seen = new Set<string>();
    for (const token of [unknown, expired.token, revoked.token, used]) {
      const viaAccept = await accept(visitor, token);
      const viaPreview = await t.http.get('/api/invites/preview').query({ token });
      expect(viaAccept.status).toBe(404);
      expect(viaPreview.status).toBe(404);
      seen.add(JSON.stringify(viaAccept.body));
      seen.add(JSON.stringify(viaPreview.body));
    }
    expect(seen.size).toBe(1);
    expect((await accept(visitor, mine.token)).status).toBe(200); // the good one still works
  });
});

describe('email invites', () => {
  it('mails the link and replies the same whether or not the address has an account', async () => {
    const team = await newTeam();
    const known = await invite(owner, team.id, { email: other.email });
    const unknown = await invite(owner, team.id, { email: 'nobody-here@example.com' });
    expect(known.status).toBe(201);
    expect(unknown.status).toBe(201);
    const shape = (b: Record<string, unknown>) => Object.keys(b).sort().join();
    expect(shape(known.body)).toBe(shape(unknown.body));
    expect(known.body.url).toBeNull();
    expect(unknown.body.url).toBeNull();
    expect(t.mail.last('invite', other.email)?.team).toBe('Rocket');
    expect(t.mail.last('invite', 'nobody-here@example.com')).toBeDefined();
    // the token is not kept: not in the list, only its hash in the table
    const list = await t.http.get(`/api/teams/${team.id}/invites`).set(owner.auth);
    expect(JSON.stringify(list.body)).not.toContain(t.mail.last('invite', other.email)!.token);
    expect(
      (await t.prisma.invite.findFirstOrThrow({ where: { email: other.email } })).tokenHash,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is accepted only by the verified address it was sent to, once', async () => {
    const team = await newTeam();
    const email = uniqueEmail('invitee');
    await invite(owner, team.id, { email });
    const token = t.mail.last('invite', email)!.token;

    expect((await accept(visitor, token)).status).toBe(403); // verified, but another address
    expect(await isMember(team.id, visitor)).toBe(false);

    const wanted = await signup(t, false, email); // right address, not verified yet
    const early = await accept(wanted, token);
    expect(early.status).toBe(403);
    expect(early.body.message).toBe('email_not_verified');

    await t.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    expect((await accept(wanted, token)).body.joined).toBe(true);
    expect((await accept(visitor, token)).status).toBe(404); // used now
  });

  it('matches the address regardless of case', async () => {
    const team = await newTeam();
    await invite(owner, team.id, { email: other.email.toUpperCase() });
    const token = t.mail.last('invite', other.email)!.token;
    expect((await accept(other, token)).status).toBe(200);
  });

  it('can be resent with a new token, and revoked', async () => {
    const team = await newTeam();
    const created = await invite(owner, team.id, { email: 'again@example.com' });
    const first = t.mail.last('invite', 'again@example.com')!.token;
    const resent = await t.http.post(`/api/invites/${created.body.id}/resend`).set(owner.auth);
    expect(resent.status).toBe(200);
    const second = t.mail.sent.filter((m) => m.kind === 'invite').at(-1)!.token;
    expect(second).not.toBe(first);
    expect((await t.http.get('/api/invites/preview').query({ token: first })).status).toBe(404);
    expect((await t.http.get('/api/invites/preview').query({ token: second })).status).toBe(200);

    expect((await t.http.delete(`/api/invites/${created.body.id}`).set(owner.auth)).status).toBe(
      204,
    );
    expect((await t.http.delete(`/api/invites/${created.body.id}`).set(owner.auth)).status).toBe(
      204,
    ); // again: nothing
    expect((await t.http.get('/api/invites/preview').query({ token: second })).status).toBe(404);
    expect(
      (await t.http.post(`/api/invites/${created.body.id}/resend`).set(owner.auth)).status,
    ).toBe(422);
    expect((await audit(team.id, 'invite.revoke')).length).toBe(1);
    expect((await audit(team.id, 'invite.resend')).length).toBe(1);
  });

  it('a newer invitation to the same address replaces the older one', async () => {
    const team = await newTeam();
    await invite(owner, team.id, { email: 'twice@example.com' });
    const older = t.mail.last('invite', 'twice@example.com')!.token;
    await invite(owner, team.id, { email: 'twice@example.com' });
    expect((await t.http.get('/api/invites/preview').query({ token: older })).status).toBe(404);
    const list = await t.http.get(`/api/teams/${team.id}/invites`).set(owner.auth);
    expect(list.body.map((i: { status: string }) => i.status).sort()).toEqual([
      'active',
      'revoked',
    ]);
  });
});

describe('registering with an invite', () => {
  it('creates the account, and joins only after the address is verified', async () => {
    const team = await newTeam();
    const role = await t.http
      .post(`/api/teams/${team.id}/roles`)
      .set(owner.auth)
      .send({ name: 'Dev', permissions: bits(P.EDIT_PAGES) });
    const email = uniqueEmail('new');
    await invite(owner, team.id, { email, roleIds: [role.body.id] });
    const token = t.mail.last('invite', email)!.token;

    const reg = await t.http
      .post('/api/auth/register')
      .send({ email, password: GOOD_PASSWORD, displayName: 'Nova', inviteToken: token });
    expect(reg.status).toBe(201);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await isMember(team.id, { id: user.id } as Account)).toBe(false); // not before verification

    const verify = t.mail.last('verify', email)!;
    expect((await t.http.post('/api/auth/verify-email').send({ token: verify.token })).status).toBe(
      200,
    );
    expect(await isMember(team.id, { id: user.id } as Account)).toBe(true);
    expect(
      await t.prisma.memberRole.count({ where: { userId: user.id, roleId: role.body.id } }),
    ).toBe(1);
    expect(await t.prisma.pendingInvite.count({ where: { userId: user.id } })).toBe(0);
    expect((await t.prisma.invite.findFirstOrThrow({ where: { email } })).acceptedBy).toBe(user.id);
  });

  it('registering with a bad token still works and says nothing about it', async () => {
    const email = uniqueEmail('plain');
    const reg = await t.http
      .post('/api/auth/register')
      .send({ email, password: GOOD_PASSWORD, displayName: 'P', inviteToken: 'z'.repeat(43) });
    expect(reg.status).toBe(201);
    expect(await t.prisma.pendingInvite.count()).toBe(0);
  });

  it('an email invite does not join an account with another address', async () => {
    const team = await newTeam();
    await invite(owner, team.id, { email: 'right@example.com' });
    const token = t.mail.last('invite', 'right@example.com')!.token;
    const email = uniqueEmail('wrong');
    await t.http
      .post('/api/auth/register')
      .send({ email, password: GOOD_PASSWORD, displayName: 'W', inviteToken: token });
    await t.http.post('/api/auth/verify-email').send({ token: await verifyToken(email) });
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await isMember(team.id, { id: user.id } as Account)).toBe(false);
    expect((await t.http.get('/api/invites/preview').query({ token })).status).toBe(200); // still open for the right person
  });

  it('a link joins people who registered with it', async () => {
    const team = await newTeam();
    const { token } = await link(owner, team.id);
    const email = uniqueEmail('vialink');
    const regL = await t.http
      .post('/api/auth/register')
      .send({ email, password: GOOD_PASSWORD, displayName: 'L', inviteToken: token });
    expect(regL.status, JSON.stringify(regL.body)).toBe(201);
    await t.http.post('/api/auth/verify-email').send({ token: await verifyToken(email) });
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await isMember(team.id, { id: user.id } as Account)).toBe(true);
  });
});

describe('who may invite', () => {
  it('404 outside the team, 403 without CREATE_INVITES, allowed with it', async () => {
    const team = await newTeam();
    const mine = await link(owner, team.id);
    const calls = (w: Account) => [
      invite(w, team.id, { link: true }),
      t.http.get(`/api/teams/${team.id}/invites`).set(w.auth),
      t.http.delete(`/api/invites/${mine.id}`).set(w.auth),
      t.http.post(`/api/invites/${mine.id}/resend`).set(w.auth),
    ];
    expect((await Promise.all(calls(visitor))).map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect((await Promise.all(calls(plain))).map((r) => r.status)).toEqual([403, 403, 403, 403]);
    await grant(team.id, plain, P.CREATE_INVITES);
    expect((await invite(plain, team.id, { link: true })).status).toBe(201);
    expect((await t.http.get(`/api/teams/${team.id}/invites`).set(plain.auth)).status).toBe(200);
    expect((await t.http.get('/api/invites/preview').query({ token: 'short' })).status).toBe(400);
  });

  it('an invite stops working when its maker is removed from the team', async () => {
    const team = await newTeam();
    await grant(team.id, plain, P.CREATE_INVITES);
    const { token } = await link(plain, team.id);
    expect(
      (await t.http.delete(`/api/teams/${team.id}/members/${plain.id}`).set(owner.auth)).status,
    ).toBe(204);
    expect((await accept(visitor, token)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ pending ownership

describe('ownership promised to an email address', () => {
  it('goes to the person once they register and verify; the admin who made the team is not in it', async () => {
    const email = uniqueEmail('future');
    const team = await newTeam({}, email, []);
    expect(t.mail.last('ownership', email)).toMatchObject({ ownership: 'offered', team: 'Rocket' });

    const reg = await t.http
      .post('/api/auth/register')
      .send({ email, password: GOOD_PASSWORD, displayName: 'Future' });
    expect(reg.status).toBe(201);
    expect((await t.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).ownerId).toBeNull(); // not before verifying
    await t.http.post('/api/auth/verify-email').send({ token: await verifyToken(email) });

    const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    expect((await t.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).ownerId).toBe(
      user.id,
    );
    expect(await isMember(team.id, { id: user.id } as Account)).toBe(true);
    expect(await isMember(team.id, admin)).toBe(false);
    expect(t.mail.last('ownership', email)).toMatchObject({
      ownership: 'assigned',
      name: 'Future',
    });
    expect(await t.prisma.pendingOwner.count({ where: { teamId: team.id } })).toBe(0);
  });
});

// ------------------------------------------------------------------ directory and requests

describe('the public directory', () => {
  it('lists public teams only, finds them by name, blurb and tag, and hides private ones even by exact name', async () => {
    const open = await newTeam({ name: 'Public Rockets', isPublic: true, joinPolicy: 'open' });
    await t.http
      .patch(`/api/teams/${open.id}`)
      .set(owner.auth)
      .send({ listingBlurb: 'We build rockets', listingTags: ['Space', 'space', 'Hardware'] });
    const secret = await newTeam({ name: 'Secret Club' });

    const all = await t.http.get('/api/directory').set(visitor.auth);
    expect(all.status).toBe(200);
    expect(all.body.items.map((x: { id: string }) => x.id)).toEqual([open.id]);
    expect(all.body.items[0]).toMatchObject({
      blurb: 'We build rockets',
      tags: ['space', 'hardware'],
      joinPolicy: 'open',
      memberCount: 2,
      mine: 'none',
    });

    const find = async (qs: object) =>
      (await t.http.get('/api/directory').query(qs).set(visitor.auth)).body.items.length;
    expect(await find({ q: 'ROCKETS' })).toBe(1);
    expect(await find({ q: 'build' })).toBe(1);
    expect(await find({ tag: 'hardware' })).toBe(1);
    expect(await find({ tag: 'cooking' })).toBe(0);
    expect(await find({ q: 'Secret Club' })).toBe(0);

    expect((await t.http.get(`/api/directory/${open.slug}`).set(visitor.auth)).status).toBe(200);
    expect((await t.http.get(`/api/directory/${secret.slug}`).set(visitor.auth)).status).toBe(404);
    expect((await t.http.get('/api/directory')).status).toBe(401);
    // joining a private team by id looks like a team that does not exist
    expect(
      (await t.http.post(`/api/teams/${secret.id}/join`).set(visitor.auth).send({})).status,
    ).toBe(404);
    // a team that is deleted disappears
    await t.http.delete(`/api/admin/teams/${open.id}`).set(admin.auth);
    expect((await t.http.get('/api/directory').set(visitor.auth)).body.items).toEqual([]);
  });

  it('pages through the list', async () => {
    for (const name of ['Alpha', 'Bravo', 'Charlie'])
      await newTeam({ name, isPublic: true }, owner.email, []);
    const first = await t.http.get('/api/directory').query({ limit: 2 }).set(visitor.auth);
    expect(first.body.items.map((x: { name: string }) => x.name)).toEqual(['Alpha', 'Bravo']);
    const next = await t.http
      .get('/api/directory')
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set(visitor.auth);
    expect(next.body.items.map((x: { name: string }) => x.name)).toEqual(['Charlie']);
    expect(next.body.nextCursor).toBeNull();
  });
});

describe('joining a public team', () => {
  it('policy open: a member at once', async () => {
    const team = await newTeam({ isPublic: true, joinPolicy: 'open' });
    const res = await t.http.post(`/api/teams/${team.id}/join`).set(visitor.auth).send({});
    expect(res.body).toEqual({ status: 'joined', teamId: team.id });
    expect(await isMember(team.id, visitor)).toBe(true);
    expect((await audit(team.id, 'member.add')).length).toBe(1);
    expect(
      (await t.http.post(`/api/teams/${team.id}/join`).set(visitor.auth).send({})).body.status,
    ).toBe('joined'); // again: nothing
    expect((await t.http.get(`/api/directory/${team.slug}`).set(visitor.auth)).body.mine).toBe(
      'member',
    );
  });

  it('needs a verified address', async () => {
    const team = await newTeam({ isPublic: true, joinPolicy: 'open' });
    const fresh = await signup(t, false);
    const res = await t.http.post(`/api/teams/${team.id}/join`).set(fresh.auth).send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('email_not_verified');
  });

  it('policy request: a pending request that can be approved, denied or withdrawn; never two at once', async () => {
    const team = await newTeam({ isPublic: true, joinPolicy: 'request' });
    const ask = (w: Account, message = '') =>
      t.http.post(`/api/teams/${team.id}/join`).set(w.auth).send({ message });

    expect((await ask(visitor, 'let me in')).body.status).toBe('requested');
    expect((await ask(visitor)).body.status).toBe('requested');
    expect(
      await t.prisma.joinRequest.count({ where: { teamId: team.id, userId: visitor.id } }),
    ).toBe(1);
    expect(await isMember(team.id, visitor)).toBe(false);
    expect((await t.http.get(`/api/directory/${team.slug}`).set(visitor.auth)).body.mine).toBe(
      'requested',
    );

    // only people who manage members may look at and decide on requests
    const list = (w: Account) => t.http.get(`/api/teams/${team.id}/join-requests`).set(w.auth);
    expect((await list(other)).status).toBe(404);
    expect((await list(plain)).status).toBe(403);
    const seen = await list(owner);
    expect(seen.body).toHaveLength(1);
    expect(seen.body[0]).toMatchObject({
      userId: visitor.id,
      message: 'let me in',
      status: 'pending',
    });
    const rid = seen.body[0].id as string;
    expect(
      (await t.http.post(`/api/teams/${team.id}/join-requests/${rid}/approve`).set(plain.auth))
        .status,
    ).toBe(403);
    expect(
      (await t.http.post(`/api/teams/${team.id}/join-requests/${rid}/approve`).set(other.auth))
        .status,
    ).toBe(404);
    expect(
      (await t.http.get(`/api/teams/${team.id}/me`).set(owner.auth)).body.pendingRequests,
    ).toBe(1);
    expect(
      (await t.http.get(`/api/teams/${team.id}/me`).set(plain.auth)).body.pendingRequests,
    ).toBe(0);

    expect(
      (await t.http.post(`/api/teams/${team.id}/join-requests/${rid}/approve`).set(owner.auth))
        .status,
    ).toBe(204);
    expect(await isMember(team.id, visitor)).toBe(true);
    expect(t.mail.last('decision', visitor.email)).toMatchObject({
      approved: true,
      team: 'Rocket',
    });
    expect(
      (await t.http.post(`/api/teams/${team.id}/join-requests/${rid}/approve`).set(owner.auth))
        .status,
    ).toBe(404); // decided already
    expect((await audit(team.id, 'request.approve')).length).toBe(1);

    // a denied request: a neutral state, and the person can ask again
    expect((await ask(other)).body.status).toBe('requested');
    const rid2 = (await list(owner)).body[0].id as string;
    expect(
      (await t.http.post(`/api/teams/${team.id}/join-requests/${rid2}/deny`).set(owner.auth))
        .status,
    ).toBe(204);
    expect(t.mail.last('decision', other.email)).toMatchObject({ approved: false });
    expect(await isMember(team.id, other)).toBe(false);
    expect((await t.http.get(`/api/directory/${team.slug}`).set(other.auth)).body.mine).toBe(
      'none',
    );
    expect((await ask(other)).body.status).toBe('requested');

    // withdrawing
    expect((await t.http.delete(`/api/teams/${team.id}/join-request`).set(other.auth)).status).toBe(
      204,
    );
    expect((await t.http.delete(`/api/teams/${team.id}/join-request`).set(other.auth)).status).toBe(
      404,
    );
    expect((await list(owner)).body).toEqual([]);
    expect((await audit(team.id, 'request.deny')).length).toBe(1);
  });

  it('joining by an invite closes a pending request', async () => {
    const team = await newTeam({ isPublic: true, joinPolicy: 'request' });
    await t.http.post(`/api/teams/${team.id}/join`).set(visitor.auth).send({});
    const { token } = await link(owner, team.id);
    await accept(visitor, token);
    expect(await t.prisma.joinRequest.count({ where: { teamId: team.id, pending: 1 } })).toBe(0);
  });
});

// ------------------------------------------------------------------ bans, leaving, ownership

describe('bans', () => {
  it('keep a person out by every way in, and lifting the ban lets them back', async () => {
    const team = await newTeam({ isPublic: true, joinPolicy: 'open' });
    await t.http.post(`/api/teams/${team.id}/join`).set(visitor.auth).send({});
    expect(await isMember(team.id, visitor)).toBe(true);

    expect(
      (
        await t.http
          .put(`/api/teams/${team.id}/bans/${visitor.id}`)
          .set(plain.auth)
          .send({ reason: 'x' })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.http
          .put(`/api/teams/${team.id}/bans/${visitor.id}`)
          .set(owner.auth)
          .send({ reason: 'spam' })
      ).status,
    ).toBe(204);
    expect(await isMember(team.id, visitor)).toBe(false); // banning removes them
    expect((await audit(team.id, 'member.ban')).length).toBe(1);

    const mine = await link(owner, team.id);
    await invite(owner, team.id, { email: visitor.email });
    const mailed = t.mail.last('invite', visitor.email)!.token;
    const viaLink = await accept(visitor, mine.token);
    expect([viaLink.status, viaLink.body.message]).toEqual([404, 'invalid_invite']); // nothing says why
    expect((await accept(visitor, mailed)).status).toBe(404);
    const viaDirectory = await t.http.post(`/api/teams/${team.id}/join`).set(visitor.auth).send({});
    expect(viaDirectory.status).toBe(403);
    expect(JSON.stringify(viaDirectory.body)).not.toContain(owner.id);
    expect((await t.http.get('/api/directory').set(visitor.auth)).body.items).toEqual([]);
    expect(await isMember(team.id, visitor)).toBe(false);

    const list = await t.http.get(`/api/teams/${team.id}/bans`).set(owner.auth);
    expect(list.body).toMatchObject([{ userId: visitor.id, reason: 'spam' }]);
    expect((await t.http.get(`/api/teams/${team.id}/bans`).set(plain.auth)).status).toBe(403);

    expect(
      (await t.http.delete(`/api/teams/${team.id}/bans/${visitor.id}`).set(owner.auth)).status,
    ).toBe(204);
    expect(
      (await t.http.delete(`/api/teams/${team.id}/bans/${visitor.id}`).set(owner.auth)).status,
    ).toBe(204); // again: nothing
    expect((await audit(team.id, 'member.unban')).length).toBe(1);
    expect((await accept(visitor, mine.token)).status).toBe(200);
  });

  it('closes a pending request and drops a registered-with invite', async () => {
    const team = await newTeam({ isPublic: true, joinPolicy: 'request' });
    await t.http.post(`/api/teams/${team.id}/join`).set(visitor.auth).send({});
    await t.http.put(`/api/teams/${team.id}/bans/${visitor.id}`).set(owner.auth).send({});
    expect(await t.prisma.joinRequest.count({ where: { teamId: team.id, pending: 1 } })).toBe(0);
    expect(
      (await t.http.post(`/api/teams/${team.id}/join`).set(visitor.auth).send({})).status,
    ).toBe(403);
  });

  it('cannot ban the owner, oneself, or someone of the same rank; the owner may ban anyone', async () => {
    const team = await newTeam();
    const helper = await signup(t);
    await t.prisma.teamMember.create({ data: { teamId: team.id, userId: helper.id } });
    await grant(team.id, plain, P.MANAGE_MEMBERS);
    await grant(team.id, helper, P.MANAGE_MEMBERS);
    const put = (by: Account, who: string) =>
      t.http.put(`/api/teams/${team.id}/bans/${who}`).set(by.auth).send({});

    // new roles start at the bottom, so plain's (made first) now ranks above helper's
    expect((await put(plain, owner.id)).status).toBe(422);
    expect((await put(plain, plain.id)).status).toBe(422);
    expect((await put(helper, plain.id)).status).toBe(403); // a lower rank cannot ban a higher one
    expect((await put(plain, helper.id)).status).toBe(204);
    expect((await put(owner, plain.id)).status).toBe(204); // the owner outranks everybody
    expect(await isMember(team.id, plain)).toBe(false);
  });
});

describe('leaving, removing and handing over', () => {
  it('a member can leave; the owner cannot until ownership moves', async () => {
    const team = await newTeam();
    expect((await t.http.delete(`/api/teams/${team.id}/members/me`).set(plain.auth)).status).toBe(
      204,
    );
    expect(await isMember(team.id, plain)).toBe(false);
    const stuck = await t.http.delete(`/api/teams/${team.id}/members/me`).set(owner.auth);
    expect([stuck.status, stuck.body.message]).toEqual([422, 'owner_cannot_leave']);
    expect((await t.http.delete(`/api/teams/${team.id}/members/me`).set(visitor.auth)).status).toBe(
      404,
    ); // not in it
  });

  it('kicking needs MANAGE_MEMBERS and a higher rank than the person kicked', async () => {
    const team = await newTeam();
    const lead = await signup(t);
    await t.prisma.teamMember.create({ data: { teamId: team.id, userId: lead.id } });
    // plain holds a role above lead's (roles made later start lower)
    await grant(team.id, plain, P.MANAGE_MEMBERS);
    await grant(team.id, lead, P.MANAGE_MEMBERS);

    const kick = (by: Account, who: Account) =>
      t.http.delete(`/api/teams/${team.id}/members/${who.id}`).set(by.auth);
    expect((await kick(lead, plain)).status).toBe(403); // plain outranks lead
    expect((await kick(lead, owner)).status).toBe(422);
    expect((await kick(visitor, plain)).status).toBe(404);
    expect((await kick(plain, lead)).status).toBe(204);
    expect(await isMember(team.id, lead)).toBe(false);
  });

  it('transfers ownership: owner only, with the password; the old owner keeps roles but loses the bypass', async () => {
    const team = await newTeam();
    const role = await grant(team.id, owner, P.EDIT_PAGES);
    const transfer = (by: Account, userId: string, password = GOOD_PASSWORD) =>
      t.http
        .post(`/api/teams/${team.id}/transfer-ownership`)
        .set(by.auth)
        .send({ userId, password });

    expect((await transfer(plain, owner.id)).status).toBe(403); // not the owner
    const wrong = await transfer(owner, plain.id, 'not the password');
    expect([wrong.status, wrong.body.message]).toEqual([403, 'invalid_password']);
    expect((await transfer(owner, visitor.id)).status).toBe(422); // not a member
    expect((await transfer(owner, owner.id)).status).toBe(422);
    expect((await t.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).ownerId).toBe(
      owner.id,
    );

    expect((await transfer(owner, plain.id)).status).toBe(204);
    expect((await t.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).ownerId).toBe(
      plain.id,
    );
    expect(t.mail.last('ownership', plain.email)).toMatchObject({ ownership: 'assigned' });
    expect((await audit(team.id, 'team.owner.transfer')).length).toBe(1);

    // the previous owner still holds the role but no longer manages the team
    expect(await t.prisma.memberRole.count({ where: { userId: owner.id, roleId: role } })).toBe(1);
    expect(
      (await t.http.patch(`/api/teams/${team.id}`).set(owner.auth).send({ name: 'Mine' })).status,
    ).toBe(403);
    expect(
      (await t.http.patch(`/api/teams/${team.id}`).set(plain.auth).send({ name: 'Theirs' })).status,
    ).toBe(200);
    // and may now leave
    expect((await t.http.delete(`/api/teams/${team.id}/members/me`).set(owner.auth)).status).toBe(
      204,
    );
  });
});

describe('the member limit', () => {
  it('the (max+1)th join is refused with quota_exceeded for the team, by every path', async () => {
    const team = await newTeam({ isPublic: true, joinPolicy: 'open' }); // owner and plain are in
    await t.http.put(`/api/admin/quotas/team/${team.id}`).set(admin.auth).send({ maxMembers: 3 });

    const { token } = await link(owner, team.id);
    expect((await accept(visitor, token)).status).toBe(200); // the third seat
    for (const res of [
      await accept(other, token),
      await t.http.post(`/api/teams/${team.id}/join`).set(other.auth).send({}),
    ]) {
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ code: 'quota_exceeded', scope: 'team', limit: 3 });
    }
    expect(await isMember(team.id, other)).toBe(false);
    expect((await t.prisma.invite.findFirstOrThrow({ where: { teamId: team.id } })).uses).toBe(1); // the refused try used nothing

    // a request cannot be approved into a full team, and stays pending
    await t.http.patch(`/api/teams/${team.id}`).set(owner.auth).send({ joinPolicy: 'request' });
    await t.http.post(`/api/teams/${team.id}/join`).set(other.auth).send({});
    const rid = (await t.http.get(`/api/teams/${team.id}/join-requests`).set(owner.auth)).body[0]
      .id as string;
    expect(
      (await t.http.post(`/api/teams/${team.id}/join-requests/${rid}/approve`).set(owner.auth))
        .status,
    ).toBe(413);
    expect(
      (await t.http.get(`/api/teams/${team.id}/join-requests`).set(owner.auth)).body,
    ).toHaveLength(1);
  });

  it('simultaneous joins never exceed it', async () => {
    const team = await newTeam({ isPublic: true, joinPolicy: 'open' });
    await t.http.put(`/api/admin/quotas/team/${team.id}`).set(admin.auth).send({ maxMembers: 5 });
    const crowd = await Promise.all(Array.from({ length: 8 }, () => signup(t)));
    const results = await Promise.all(
      crowd.map((w) => t.http.post(`/api/teams/${team.id}/join`).set(w.auth).send({})),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(await t.prisma.teamMember.count({ where: { teamId: team.id } })).toBe(5);
  });
});

describe('team listing settings', () => {
  it('are saved with the team, normalised, audited, and limited', async () => {
    const team = await newTeam();
    const patch = (body: object) =>
      t.http.patch(`/api/teams/${team.id}`).set(owner.auth).send(body);
    const ok = await patch({
      listingBlurb: '  Hello  ',
      listingTags: ['Rust', ' rust ', 'Open Source'],
    });
    expect(ok.body).toMatchObject({ listingBlurb: 'Hello', listingTags: ['rust', 'open source'] });
    expect((await audit(team.id, 'team.update')).length).toBe(1);
    await patch({ listingTags: ['rust', 'open source'] }); // unchanged: no second entry
    expect((await audit(team.id, 'team.update')).length).toBe(1);
    expect(
      (await patch({ listingTags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).status,
    ).toBe(400);
    expect((await patch({ listingBlurb: 'x'.repeat(201) })).status).toBe(400);
    expect(
      (await t.http.patch(`/api/teams/${team.id}`).set(plain.auth).send({ listingBlurb: 'y' }))
        .status,
    ).toBe(403);
  });
});
