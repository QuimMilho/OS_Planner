import { createECDH, createSecretKey, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Permission,
  permissionsToString,
  type ChannelDto,
  type MessageDto,
  type NotificationCountDto,
  type NotificationDto,
  type NotificationPageDto,
  type PushPayload,
  type UnreadDto,
} from '@os-planner/shared';
import { mentionToken, MUTED_FOREVER } from '@os-planner/shared/chat';
import { DigestService } from '../src/notifications/digest.service.js';
import { PushService } from '../src/notifications/push.service.js';
import { createTestApp, type TestApp } from './app.js';
import { signup, uuid, uuidv7, type Account } from './helpers.js';
import { closeSockets, collect, connect, listen, sleep } from './sockets.js';

const P = Permission;
const ADMIN_EMAIL = `notify-admin${Date.now()}@example.com`;
const HOUR = 3_600_000;

let t: TestApp;
let url: string;
let admin: Account;
let owner: Account;
let alice: Account; // writes
let bob: Account;
let carol: Account;
let dave: Account;
let outsider: Account;

let pushServer: Server;
let pushed: { path: string; status: number }[] = [];
let pushStatus = 201;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ADMIN_EMAILS',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
  'PUSH_EXTRA_ENDPOINTS',
  'NOTIFY_PUSH_COALESCE_SECONDS',
  'NOTIFY_SWEEP_SECONDS',
];

beforeAll(async () => {
  pushServer = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      pushed.push({ path: req.url ?? '', status: pushStatus });
      res.statusCode = pushStatus;
      res.end();
    });
  });
  await new Promise<void>((r) => pushServer.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(pushServer.address() as AddressInfo).port}`;
  const vapid = webpush.generateVAPIDKeys();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    ADMIN_EMAILS: ADMIN_EMAIL,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:test@example.com',
    PUSH_EXTRA_ENDPOINTS: origin,
    NOTIFY_PUSH_COALESCE_SECONDS: '0',
    NOTIFY_SWEEP_SECONDS: '0',
  });
  t = await createTestApp();
  url = await listen(t);
});
afterAll(async () => {
  closeSockets();
  await t.close();
  await new Promise<void>((r) => pushServer.close(() => r()));
  for (const k of ENV_KEYS)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
});
beforeEach(async () => {
  await t.prisma.team.deleteMany();
  await t.prisma.user.deleteMany();
  await t.prisma.channel.deleteMany({ where: { kind: 'dm' } });
  t.mail.sent.length = 0;
  pushed = [];
  pushStatus = 201;
  admin = await signup(t, true, ADMIN_EMAIL);
  owner = await signup(t);
  alice = await signup(t);
  bob = await signup(t);
  carol = await signup(t);
  dave = await signup(t);
  outsider = await signup(t);
});
afterEach(() => {
  closeSockets();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ helpers

interface Team {
  id: string;
  spaceId: string;
}

async function newTeam(members: Account[] = [alice, bob, carol, dave]): Promise<Team> {
  const res = await t.http
    .post('/api/admin/teams')
    .set(admin.auth)
    .send({ name: 'Notifiers', ownerEmail: owner.email });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const m of members)
    await t.prisma.teamMember.create({ data: { teamId: res.body.id, userId: m.id } });
  const row = await t.prisma.team.findUniqueOrThrow({ where: { id: res.body.id } });
  return { id: row.id, spaceId: row.spaceId };
}

const newChannel = async (
  who: Account,
  spaceId: string,
  body: object = {},
): Promise<ChannelDto> => {
  const res = await t.http
    .post(`/api/spaces/${spaceId}/channels`)
    .set(who.auth)
    .send({ name: 'general', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as ChannelDto;
};

const send = (who: Account, channelId: string, content: string, extra: object = {}) =>
  t.http
    .post(`/api/channels/${channelId}/messages`)
    .set(who.auth)
    .send({ id: uuidv7(), content, ...extra });

const sendOk = async (
  who: Account,
  channelId: string,
  content: string,
  extra: object = {},
): Promise<MessageDto> => {
  const res = await send(who, channelId, content, extra);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as MessageDto;
};

const inbox = async (who: Account, query: object = {}): Promise<NotificationDto[]> =>
  ((await t.http.get('/api/notifications').set(who.auth).query(query)).body as NotificationPageDto)
    .items;
const counts = async (who: Account): Promise<NotificationCountDto> =>
  (await t.http.get('/api/notifications/count').set(who.auth)).body;
const kindsOf = async (who: Account): Promise<string[]> => (await inbox(who)).map((n) => n.kind);

async function giveRole(
  team: Team,
  who: Account,
  bits: bigint,
  extra: object = {},
): Promise<string> {
  const res = await t.http
    .post(`/api/teams/${team.id}/roles`)
    .set(owner.auth)
    .send({
      name: `r${Math.random().toString(36).slice(2, 8)}`,
      permissions: permissionsToString(bits),
      ...extra,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(
    (
      await t.http
        .put(`/api/teams/${team.id}/members/${who.id}/roles/${res.body.id}`)
        .set(owner.auth)
    ).status,
  ).toBe(204);
  return res.body.id as string;
}

const setting = (who: Account, body: object) =>
  t.http.put('/api/notification-settings').set(who.auth).send(body);
const mute = (who: Account, scopeKind: string, scopeId: string | null, until: string | null) =>
  t.http.post('/api/notification-settings/mute').set(who.auth).send({ scopeKind, scopeId, until });
const effective = async (who: Account, scopeKind: string, scopeId?: string) =>
  (
    await t.http
      .get('/api/notification-settings/effective')
      .set(who.auth)
      .query({ scopeKind, ...(scopeId ? { scopeId } : {}) })
  ).body;

const mentionUser = (a: Account): string => mentionToken('user', a.id);

// ------------------------------------------------------------------ what a message accepts

describe('mentions', () => {
  it('are accepted only when they hold, and the server decides', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const mentionable = await giveRole(team, carol, 0n, { mentionable: true });
    const quiet = await giveRole(team, dave, 0n, { mentionable: false });
    const text = `hi ${mentionUser(bob)} ${mentionUser(outsider)} ${mentionToken('role', mentionable)} ${mentionToken('role', quiet)} ${mentionToken('role', uuid())} <@everyone> <@here> ${mentionUser(alice)}`;

    const fromMember = await sendOk(alice, ch.id, text);
    // alice may not mention everyone and cannot make a role mentionable; an outsider and a stranger id are nobody; she is not told about herself
    expect(fromMember.mentions).toEqual({
      users: [bob.id],
      roles: [mentionable],
      everyone: false,
      here: false,
    });
    expect(
      (await t.prisma.message.findUniqueOrThrow({ where: { id: fromMember.id } })).mentions,
    ).toEqual(fromMember.mentions);

    // the owner may mention everyone and any role
    const fromOwner = await sendOk(owner, ch.id, text);
    expect(fromOwner.mentions).toEqual({
      users: [bob.id, alice.id],
      roles: [mentionable, quiet],
      everyone: true,
      here: true,
    });

    // nothing in the request can set it
    const forged = await send(alice, ch.id, 'plain', {
      mentions: { users: [bob.id], roles: [], everyone: true, here: true },
    });
    expect(forged.body.mentions).toEqual({ users: [], roles: [], everyone: false, here: false });
    // a person who cannot see the channel is not a mention
    await t.http
      .put('/api/overwrites')
      .set(owner.auth)
      .send({
        targetKind: 'channel',
        targetId: ch.id,
        subjectKind: 'member',
        subjectId: bob.id,
        allow: '0',
        deny: permissionsToString(P.VIEW_CHANNEL),
      });
    expect((await sendOk(alice, ch.id, mentionUser(bob))).mentions.users).toEqual([]);
    // tokens in code are text
    expect((await sendOk(alice, ch.id, `\`${mentionUser(carol)}\``)).mentions.users).toEqual([]);
  });

  it('refuses @everyone in a team too big to be told at once', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    // five thousand real accounts are too heavy for a test: the count is what the check reads
    const { NOTIFY_LIMITS } = await import('@os-planner/shared/chat');
    const spy = vi
      .spyOn(t.prisma.teamMember, 'count')
      .mockResolvedValue(NOTIFY_LIMITS.everyoneMaxMembers + 1);
    const res = await send(owner, ch.id, '<@everyone> hello');
    spy.mockRestore();
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('everyone_too_large');
    expect(await t.prisma.message.count({ where: { channelId: ch.id } })).toBe(0);
  });
});

// ------------------------------------------------------------------ who is told

describe('notifications', () => {
  it('tell exactly the right people: the person, a role, everyone, those online', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const role = await giveRole(team, carol, 0n, { mentionable: true });
    const hidden = dave;
    await t.http
      .put('/api/overwrites')
      .set(owner.auth)
      .send({
        targetKind: 'channel',
        targetId: ch.id,
        subjectKind: 'member',
        subjectId: hidden.id,
        allow: '0',
        deny: permissionsToString(P.VIEW_CHANNEL),
      });

    await sendOk(
      alice,
      ch.id,
      `${mentionUser(bob)} ${mentionToken('role', role)} ${mentionUser(dave)}`,
    );
    expect(await kindsOf(bob)).toEqual(['mention_user']);
    expect(await kindsOf(carol)).toEqual(['mention_role']);
    expect(await kindsOf(dave)).toEqual([]); // cannot see the channel: told nothing
    expect(await kindsOf(alice)).toEqual([]); // never the author
    expect(await kindsOf(owner)).toEqual([]);
    expect(await kindsOf(outsider)).toEqual([]);

    // @everyone reaches everybody who can see the channel but the author
    await sendOk(owner, ch.id, 'meeting <@everyone>');
    expect((await inbox(alice)).map((n) => n.kind)).toEqual(['mention_everyone']);
    expect((await inbox(bob)).map((n) => n.kind)).toEqual(['mention_everyone', 'mention_user']);
    expect(await kindsOf(carol)).toEqual(['mention_everyone', 'mention_role']);
    expect(await kindsOf(dave)).toEqual([]);
    expect(await kindsOf(owner)).toEqual([]);

    // @here is for those online now
    const online = await connect(url, carol);
    await sleep(100);
    await sendOk(owner, ch.id, 'quick <@here>');
    expect((await inbox(carol))[0]!.kind).toBe('mention_here');
    expect((await inbox(bob))[0]!.kind).toBe('mention_everyone'); // not online: nothing new
    expect(online.connected).toBe(true);
  });

  it('use the strongest way a person was mentioned once, with a readable summary', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const role = await giveRole(team, bob, 0n, { mentionable: true });
    await sendOk(alice, ch.id, `**look** ${mentionToken('role', role)} ${mentionUser(bob)} please`);
    const items = await inbox(bob);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'mention_user',
      actorId: alice.id,
      actorName: 'Test',
      channelId: ch.id,
      channelName: 'general',
      teamId: team.id,
      redacted: false,
      read: false,
    });
    expect(items[0]!.summary).toContain('look');
    expect(items[0]!.summary).toContain('@Test'); // the name, not the token
    expect(items[0]!.summary).not.toContain('<@');
  });

  it('tell the author of a message that was replied to, and the person in a thread', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const first = await sendOk(bob, ch.id, 'question');
    await sendOk(alice, ch.id, 'answer', { replyToId: first.id });
    expect((await inbox(bob)).map((n) => n.kind)).toEqual(['reply']);
    await sendOk(bob, ch.id, 'self reply', { replyToId: first.id });
    expect(await kindsOf(bob)).toEqual(['reply']); // not about oneself
  });

  it('are silenced by mutes and switches, but a direct mention is the last to go', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    await giveRole(team, owner, P.MENTION_EVERYONE);
    const role = await giveRole(team, bob, 0n, { mentionable: true });
    const all = (text: string) => `${text} <@everyone> ${mentionToken('role', role)}`;

    // muted for an hour: @everyone and roles are silent, the person's own name is not
    expect(
      (await mute(bob, 'channel', ch.id, new Date(Date.now() + HOUR).toISOString())).status,
    ).toBe(200);
    await sendOk(owner, ch.id, all('a'));
    expect(await kindsOf(bob)).toEqual([]);
    await sendOk(owner, ch.id, `b ${mentionUser(bob)}`);
    expect(await kindsOf(bob)).toEqual(['mention_user']);
    // until "suppress direct" is on
    await setting(bob, { scopeKind: 'channel', scopeId: ch.id, suppressDirect: true });
    await sendOk(owner, ch.id, `c ${mentionUser(bob)}`);
    expect(await kindsOf(bob)).toEqual(['mention_user']);
    // an ended mute silences nothing
    await setting(bob, {
      scopeKind: 'channel',
      scopeId: ch.id,
      suppressDirect: false,
      mutedUntil: new Date(Date.now() - 1000).toISOString(),
    });
    await sendOk(owner, ch.id, all('d'));
    expect(await kindsOf(bob)).toEqual(['mention_role', 'mention_user']); // @everyone and the role in one message: one notification, the stronger kind

    // separate switches
    const carolBefore = (await kindsOf(carol)).length;
    const daveBefore = (await kindsOf(dave)).length;
    await setting(carol, { scopeKind: 'team', scopeId: team.id, suppressEveryone: true });
    await sendOk(owner, ch.id, '<@everyone> e');
    expect(await kindsOf(carol)).toHaveLength(carolBefore);
    expect(await kindsOf(dave)).toHaveLength(daveBefore + 1); // dave did not switch it off
    await setting(dave, { scopeKind: 'team', scopeId: team.id, suppressRoles: true });
    const roleForDave = await giveRole(team, dave, 0n, { mentionable: true });
    await sendOk(owner, ch.id, mentionToken('role', roleForDave));
    expect(await kindsOf(dave)).toHaveLength(daveBefore + 1);
    await sendOk(owner, ch.id, mentionUser(dave));
    expect((await kindsOf(dave))[0]).toBe('mention_user');
    expect(await kindsOf(dave)).toHaveLength(daveBefore + 2);
  });

  it('follow the nearest setting: a muted team can be un-muted for one channel, and "nothing" silences roles', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const other = await newChannel(owner, team.spaceId, { name: 'other' });
    const role = await giveRole(team, bob, 0n, { mentionable: true });
    await mute(bob, 'team', team.id, MUTED_FOREVER);
    await sendOk(alice, ch.id, mentionToken('role', role));
    expect(await kindsOf(bob)).toEqual([]);
    expect(await effective(bob, 'channel', ch.id)).toMatchObject({
      muted: true,
      sources: { mute: { scopeKind: 'team', scopeId: team.id } },
    });

    // un-mute the channel inside the muted team: a time that has already passed is stored
    const un = await mute(bob, 'channel', ch.id, null);
    expect(un.status).toBe(200);
    expect(new Date(un.body.mutedUntil).getTime()).toBeLessThan(Date.now());
    expect(await effective(bob, 'channel', ch.id)).toMatchObject({
      muted: false,
      sources: { mute: { scopeKind: 'channel' } },
    });
    await sendOk(alice, ch.id, mentionToken('role', role));
    expect(await kindsOf(bob)).toEqual(['mention_role']);
    await sendOk(alice, other.id, mentionToken('role', role)); // still muted there
    expect(await kindsOf(bob)).toEqual(['mention_role']);

    // outside a muted parent, turning a mute off just removes it
    await t.http
      .delete(
        `/api/notification-settings/${(await t.http.get('/api/notification-settings').set(bob.auth)).body.find((s: { scopeKind: string }) => s.scopeKind === 'team').id}`,
      )
      .set(bob.auth);
    expect((await mute(bob, 'channel', ch.id, null)).status).toBe(204);
    expect(
      await t.prisma.notificationSetting.count({ where: { userId: bob.id, scopeKind: 'channel' } }),
    ).toBe(0);
    await setting(bob, { scopeKind: 'global', level: 'none' });
    await sendOk(alice, ch.id, mentionToken('role', role));
    expect(await kindsOf(bob)).toEqual(['mention_role']);
  });

  it('are written with the message and go away with it, and follow edits', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const message = await sendOk(alice, ch.id, `hello ${mentionUser(bob)}`);
    expect(await kindsOf(bob)).toEqual(['mention_user']);

    // an edit that adds a person tells them; one that removes a person takes theirs back
    const edit = (content: string) =>
      t.http.patch(`/api/messages/${message.id}`).set(alice.auth).send({ content });
    expect((await edit(`hello ${mentionUser(bob)} and ${mentionUser(carol)}`)).status).toBe(200);
    expect(await kindsOf(bob)).toEqual(['mention_user']);
    expect(await kindsOf(carol)).toEqual(['mention_user']);
    expect((await edit(`hello ${mentionUser(carol)}`)).status).toBe(200);
    expect(await kindsOf(bob)).toEqual([]);
    expect(await kindsOf(carol)).toEqual(['mention_user']);
    expect(await edit('nobody')).toMatchObject({ status: 200 });
    expect(await kindsOf(carol)).toEqual([]);
    expect((await edit(`again ${mentionUser(carol)}`)).status).toBe(200);
    expect((await t.http.delete(`/api/messages/${message.id}`).set(alice.auth)).status).toBe(204);
    expect(await kindsOf(carol)).toEqual([]);
    expect(await t.prisma.notification.count()).toBe(0);
  });

  it('reach a person live, and read state follows them across devices', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const first = await connect(url, bob);
    const second = await connect(url, bob);
    const created = collect<NotificationDto>(first, 'notification.created');
    const read = collect<{ ids: string[]; all: boolean }>(second, 'notification.read');
    const message = await sendOk(alice, ch.id, mentionUser(bob));
    await sleep(150);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      kind: 'mention_user',
      channelId: ch.id,
      messageId: message.id,
      read: false,
    });
    // reading the channel reads its notifications, on every device
    expect(
      (
        await t.http
          .put(`/api/channels/${ch.id}/read`)
          .set(bob.auth)
          .send({ messageId: message.id })
      ).status,
    ).toBe(204);
    await sleep(150);
    expect(read.flatMap((e) => e.ids)).toEqual([created[0]!.id]);
    expect((await counts(bob)).unread).toBe(0);
    const stranger = await connect(url, carol);
    const nothing = collect(stranger, 'notification.created');
    await sleep(100);
    expect(nothing).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ who can see a channel

describe('who may be told', () => {
  it('is decided for many people at once exactly as for each one alone, in the team and in a project, with role and member overwrites', async () => {
    const team = await newTeam([alice, bob, carol, dave]);
    const hiders = await giveRole(team, dave, 0n); // a role to deny the channel to
    const pr = await t.http
      .post(`/api/teams/${team.id}/projects`)
      .set(owner.auth)
      .send({ name: 'Secret project' });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const project = await t.prisma.project.findUniqueOrThrow({ where: { id: pr.body.id } });
    for (const m of [alice, bob, dave])
      await t.prisma.projectMember.create({ data: { projectId: project.id, userId: m.id } });
    const category = await newChannel(owner, project.spaceId, { name: 'cat', kind: 'category' });
    const channel = await newChannel(owner, project.spaceId, {
      name: 'in-project',
      parentId: category.id,
    });
    const deny = (targetId: string, subjectKind: string, subjectId: string, bits: bigint) =>
      t.http
        .put('/api/overwrites')
        .set(owner.auth)
        .send({
          targetKind: 'channel',
          targetId,
          subjectKind,
          subjectId,
          allow: '0',
          deny: permissionsToString(bits),
        });
    expect((await deny(channel.id, 'member', bob.id, P.VIEW_CHANNEL)).status).toBe(200); // a person
    expect((await deny(category.id, 'role', hiders, P.VIEW_CHANNEL)).status).toBe(200); // a role, on the category

    const everyone = [owner, alice, bob, carol, dave, outsider, admin];
    const row = await t.prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
    const { PermissionService } = await import('../src/spaces/permission.service.js');
    const perms = t.app.get(PermissionService);
    const bulk = await perms.channelViewers(
      row,
      everyone.map((a) => a.id),
    );
    const alone = new Set<string>();
    for (const a of everyone) if (await perms.channelAccess(a.id, channel.id)) alone.add(a.id);
    expect([...bulk].sort()).toEqual([...alone].sort());
    // and it is not trivially everyone or nobody
    expect(bulk.has(owner.id)).toBe(true);
    expect(bulk.has(alice.id)).toBe(true);
    for (const hidden of [bob, carol, dave, outsider])
      expect(bulk.has(hidden.id), hidden.email).toBe(false);

    // a mention in that channel tells exactly those people
    await giveRole(team, owner, 0n);
    const mentioned = await sendOk(
      owner,
      channel.id,
      `${mentionUser(alice)} ${mentionUser(bob)} ${mentionUser(carol)} ${mentionUser(dave)} <@everyone>`,
    );
    expect(mentioned.mentions.users).toEqual([alice.id]);
    expect(await kindsOf(alice)).toEqual(['mention_user']);
    for (const none of [bob, carol, dave, outsider])
      expect(await kindsOf(none), none.email).toEqual([]);
  });
});

// ------------------------------------------------------------------ conversations

describe('direct messages', () => {
  it('notify the other person unless they muted the conversation', async () => {
    await newTeam();
    const dm = (await t.http.post('/api/dms').set(alice.auth).send({ userId: bob.id })).body;
    await sendOk(alice, dm.channelId, 'ping');
    expect(await kindsOf(bob)).toEqual(['dm']);
    expect((await counts(bob)).dms).toBe(1);
    expect((await inbox(bob))[0]).toMatchObject({
      summary: 'ping',
      targetKind: 'dm',
      targetId: dm.id,
      channelName: null,
    });
    expect(await kindsOf(alice)).toEqual([]);

    await mute(bob, 'dm', dm.id, new Date(Date.now() + HOUR).toISOString());
    await sendOk(alice, dm.channelId, 'again');
    expect(await kindsOf(bob)).toEqual(['dm']);
    // only the two people may set it
    expect((await mute(carol, 'dm', dm.id, new Date(Date.now() + HOUR).toISOString())).status).toBe(
      404,
    );
    // reading it reads the notification
    const last = (await t.http.get(`/api/channels/${dm.channelId}/messages`).set(bob.auth)).body
      .items[0] as MessageDto;
    await t.http
      .put(`/api/channels/${dm.channelId}/read`)
      .set(bob.auth)
      .send({ messageId: last.id });
    expect((await counts(bob)).dms).toBe(0);
  });
});

// ------------------------------------------------------------------ the inbox

describe('the inbox', () => {
  it('lists newest first in pages, filters, counts by team and marks read', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await sendOk(alice, ch.id, `m${i} ${mentionUser(bob)}`)).id);
    const dm = (await t.http.post('/api/dms').set(carol.auth).send({ userId: bob.id })).body;
    await sendOk(carol, dm.channelId, 'direct');

    const page1 = (await t.http.get('/api/notifications').set(bob.auth).query({ limit: 4 }))
      .body as NotificationPageDto;
    expect(page1.items.map((n) => n.summary)).toEqual([
      'direct',
      expect.stringContaining('m4'),
      expect.stringContaining('m3'),
      expect.stringContaining('m2'),
    ]);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (
      await t.http
        .get('/api/notifications')
        .set(bob.auth)
        .query({ limit: 4, cursor: page1.nextCursor })
    ).body as NotificationPageDto;
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((n) => n.id)).size).toBe(6);
    expect(await inbox(bob, { mentions: 'true' })).toHaveLength(5);
    expect(
      (await t.http.get('/api/notifications').set(bob.auth).query({ cursor: '!!!' })).status,
    ).toBe(200);

    expect(await counts(bob)).toEqual({ unread: 6, mentions: 5, byTeam: { [team.id]: 5 }, dms: 1 });

    // mark some, then all
    const some = page1.items.slice(0, 2).map((n) => n.id);
    expect(
      (await t.http.post('/api/notifications/read').set(bob.auth).send({ ids: some })).status,
    ).toBe(204);
    expect((await counts(bob)).unread).toBe(4);
    expect(await inbox(bob, { unread: 'true' })).toHaveLength(4);
    expect(
      await t.http
        .post('/api/notifications/read')
        .set(bob.auth)
        .send({ ids: [page1.items[0]!.id] })
        .then((r) => r.status),
    ).toBe(204);
    // somebody else's notifications cannot be marked
    expect(
      (
        await t.http
          .post('/api/notifications/read')
          .set(carol.auth)
          .send({ ids: [page2.items[0]!.id] })
      ).status,
    ).toBe(204);
    expect((await counts(bob)).unread).toBe(4);
    expect((await t.http.post('/api/notifications/read').set(bob.auth).send({})).status).toBe(400);
    expect(
      (await t.http.post('/api/notifications/read').set(bob.auth).send({ all: true })).status,
    ).toBe(204);
    expect(await counts(bob)).toEqual({ unread: 0, mentions: 0, byTeam: {}, dms: 0 });
    expect(await inbox(bob)).toHaveLength(6); // read ones stay in the list
  });

  it('show nothing of a channel the person can no longer see, and no text of a channel that hides previews', async () => {
    const team = await newTeam();
    const secret = await newChannel(owner, team.spaceId, { name: 'secret' });
    const private_ = await newChannel(owner, team.spaceId, {
      name: 'private',
      redactPreviews: true,
    });
    expect(private_.redactPreviews).toBe(true);
    await sendOk(alice, secret.id, `classified ${mentionUser(bob)}`);
    await sendOk(alice, private_.id, `classified ${mentionUser(bob)}`);
    const items = await inbox(bob);
    expect(items).toHaveLength(2);
    const redacted = items.find((n) => n.channelId === private_.id)!;
    expect(redacted).toMatchObject({ redacted: true, summary: '' });
    expect(JSON.stringify(redacted)).not.toContain('classified');
    expect(JSON.stringify(await t.prisma.notification.findMany())).not.toContain(
      'classified'.repeat(1) + '"',
    ); // not stored for the hidden one

    await t.http
      .put('/api/overwrites')
      .set(owner.auth)
      .send({
        targetKind: 'channel',
        targetId: secret.id,
        subjectKind: 'member',
        subjectId: bob.id,
        allow: '0',
        deny: permissionsToString(P.VIEW_CHANNEL),
      });
    expect((await inbox(bob)).map((n) => n.channelId)).toEqual([private_.id]);
  });

  it('counts unread mentions per channel next to the unread messages, and edits, deletes and reads keep them right', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const m1 = await sendOk(alice, ch.id, `one ${mentionUser(bob)}`);
    await sendOk(alice, ch.id, 'two');
    const unread = async (): Promise<UnreadDto> =>
      ((await t.http.get(`/api/teams/${team.id}/unread`).set(bob.auth)).body as UnreadDto[]).find(
        (u) => u.channelId === ch.id,
      )!;
    expect(await unread()).toMatchObject({ unread: 2, mentions: 1 });
    await t.http.delete(`/api/messages/${m1.id}`).set(alice.auth);
    expect(await unread()).toMatchObject({ unread: 1, mentions: 0 });
    const m3 = await sendOk(alice, ch.id, `three ${mentionUser(bob)}`);
    expect(await unread()).toMatchObject({ unread: 2, mentions: 1 });
    await t.http.put(`/api/channels/${ch.id}/read`).set(bob.auth).send({ messageId: m3.id });
    expect(await unread()).toMatchObject({ unread: 0, mentions: 0 });
  });

  it('agrees with a reference model under random sends, edits, deletes and reads', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    let seed = 20261126;
    const rand = (n: number): number =>
      (((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296) * n) | 0;
    interface Ref {
      id: string;
      mentions: boolean;
      deleted: boolean;
    }
    const model: Ref[] = [];
    let readUpTo = '';
    const text = (m: boolean, i: number): string =>
      m ? `msg ${i} ${mentionUser(bob)}` : `msg ${i}`;

    for (let step = 0; step < 60; step++) {
      const op = rand(10);
      const live = model.filter((m) => !m.deleted);
      if (op < 4 || !live.length) {
        const m = rand(2) === 0;
        const sent = await sendOk(alice, ch.id, text(m, step));
        model.push({ id: sent.id, mentions: m, deleted: false });
      } else if (op < 6) {
        const target = live[rand(live.length)]!;
        target.mentions = !target.mentions;
        expect(
          (
            await t.http
              .patch(`/api/messages/${target.id}`)
              .set(alice.auth)
              .send({ content: text(target.mentions, step) })
          ).status,
        ).toBe(200);
      } else if (op < 8) {
        const target = live[rand(live.length)]!;
        target.deleted = true;
        expect((await t.http.delete(`/api/messages/${target.id}`).set(alice.auth)).status).toBe(
          204,
        );
      } else {
        const target = model[rand(model.length)]!;
        if (target.id > readUpTo) readUpTo = target.id;
        expect(
          (
            await t.http
              .put(`/api/channels/${ch.id}/read`)
              .set(bob.auth)
              .send({ messageId: target.id })
          ).status,
        ).toBe(204);
      }
      if (step % 5 === 4 || step === 59) {
        const expected = model.filter((m) => m.mentions && !m.deleted && m.id > readUpTo).length;
        const row = (
          (await t.http.get(`/api/teams/${team.id}/unread`).set(bob.auth)).body as UnreadDto[]
        ).find((u) => u.channelId === ch.id)!;
        expect(row.mentions, `after step ${step}`).toBe(expected);
        expect((await counts(bob)).mentions, `count after step ${step}`).toBe(expected);
        expect(model.filter((m) => !m.deleted && m.id > readUpTo).length, 'unread messages').toBe(
          row.unread,
        );
      }
    }
  });

  it('are removed after 90 days', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    await sendOk(alice, ch.id, mentionUser(bob));
    await sendOk(alice, ch.id, mentionUser(carol));
    await t.prisma.notification.updateMany({
      where: { userId: bob.id },
      data: { createdAt: new Date(Date.now() - 91 * 24 * HOUR) },
    });
    const { NotificationService } = await import('../src/notifications/notification.service.js');
    expect(await t.app.get(NotificationService).prune()).toBe(1);
    expect(await kindsOf(bob)).toEqual([]);
    expect(await kindsOf(carol)).toEqual(['mention_user']);
  });
});

// ------------------------------------------------------------------ settings

describe('settings', () => {
  it('are stored per place, merged by `put`, listed, and dropped when they say nothing', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const put = await setting(bob, {
      scopeKind: 'channel',
      scopeId: ch.id,
      level: 'all',
      email: 'mentions',
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      scopeKind: 'channel',
      scopeId: ch.id,
      level: 'all',
      email: 'mentions',
      suppressRoles: null,
      mutedUntil: null,
    });
    await setting(bob, { scopeKind: 'channel', scopeId: ch.id, suppressRoles: true });
    const list = (await t.http.get('/api/notification-settings').set(bob.auth)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ level: 'all', email: 'mentions', suppressRoles: true });
    expect(await effective(bob, 'channel', ch.id)).toMatchObject({
      level: 'all',
      email: 'mentions',
      suppressRoles: true,
      push: true,
      emailOnlyWhenAway: true,
      muted: false,
      sources: { level: { scopeKind: 'channel', scopeId: ch.id }, push: { scopeKind: 'default' } },
    });
    // putting everything back to "inherit" removes the row
    const reset = await setting(bob, {
      scopeKind: 'channel',
      scopeId: ch.id,
      level: 'inherit',
      email: 'inherit',
      suppressRoles: null,
    });
    expect(reset.status).toBe(204);
    expect((await t.http.get('/api/notification-settings').set(bob.auth)).body).toEqual([]);
    // somebody else's rows are not reachable
    const mine = await setting(bob, { scopeKind: 'team', scopeId: team.id, level: 'none' });
    expect(
      (await t.http.delete(`/api/notification-settings/${mine.body.id}`).set(carol.auth)).status,
    ).toBe(404);
    expect(
      (await t.http.delete(`/api/notification-settings/${mine.body.id}`).set(bob.auth)).status,
    ).toBe(204);
  });

  it('refuse places the person cannot see, bad input, and a global "suppress direct"', async () => {
    const team = await newTeam([alice, bob]);
    const ch = await newChannel(owner, team.spaceId);
    for (const [kind, id] of [
      ['team', team.id],
      ['channel', ch.id],
      ['project', uuid()],
      ['dm', uuid()],
    ] as const)
      expect(
        (await setting(carol, { scopeKind: kind, scopeId: id, level: 'all' })).status,
        kind,
      ).toBe(404);
    expect(
      (
        await t.http
          .get('/api/notification-settings/effective')
          .set(carol.auth)
          .query({ scopeKind: 'team', scopeId: team.id })
      ).status,
    ).toBe(404);
    expect((await setting(bob, { scopeKind: 'team', level: 'all' })).status).toBe(400); // a place needs an id
    expect(
      (await setting(bob, { scopeKind: 'global', scopeId: team.id, level: 'all' })).status,
    ).toBe(400);
    expect(
      (await setting(bob, { scopeKind: 'team', scopeId: team.id, level: 'sometimes' })).status,
    ).toBe(400);
    expect((await setting(bob, { scopeKind: 'global', suppressDirect: true })).status).toBe(422);
    expect(
      (await mute(bob, 'channel', ch.id, new Date(Date.now() - HOUR).toISOString())).status,
    ).toBe(422);
    expect(
      (await setting(bob, { scopeKind: 'global', level: 'all', email: 'all', push: false })).status,
    ).toBe(200);
  });

  it('keep quiet hours for push and email', async () => {
    const hours = {
      enabled: true,
      from: '22:00',
      to: '07:00',
      days: [0, 1, 2, 3, 4, 5, 6],
      timeZone: 'Europe/Lisbon',
    };
    expect((await t.http.get('/api/notifications/quiet-hours').set(bob.auth)).status).toBe(204);
    expect(
      (await t.http.put('/api/notifications/quiet-hours').set(bob.auth).send(hours)).body,
    ).toEqual(hours);
    expect((await t.http.get('/api/notifications/quiet-hours').set(bob.auth)).body).toEqual(hours);
    expect(
      (
        await t.http
          .put('/api/notifications/quiet-hours')
          .set(bob.auth)
          .send({ ...hours, from: '25:00' })
      ).status,
    ).toBe(400);
    expect((await t.http.get('/api/notifications/quiet-hours').set(alice.auth)).status).toBe(204);
  });
});

// ------------------------------------------------------------------ push

/** A subscription the way a browser makes one: a public key and a secret to encrypt for. */
function subscription(origin: string, id = uuid()) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `${origin}/push/${id}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}
const pushOrigin = (): string => process.env.PUSH_EXTRA_ENDPOINTS!;

describe('web push', () => {
  it('has a public key only when it is configured, and only accepts addresses of known push services', async () => {
    expect((await t.http.get('/api/push/vapid-key').set(bob.auth)).body.publicKey).toBe(
      process.env.VAPID_PUBLIC_KEY,
    );
    const push = t.app.get(PushService);
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
      `${pushOrigin()}/x`,
    ])
      expect(push.endpointAllowed(ok), ok).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/x',
      'https://evil.example.com/x',
      'https://fcm.googleapis.com.evil.com/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'ftp://fcm.googleapis.com/x',
      'https://169.254.169.254/latest',
      'http://127.0.0.1:1/x',
      'not a url',
    ])
      expect(push.endpointAllowed(bad), bad).toBe(false);
    expect(
      (
        await t.http
          .post('/api/push/subscribe')
          .set(bob.auth)
          .send({ ...subscription(pushOrigin()), endpoint: 'https://evil.example.com/x' })
      ).status,
    ).toBe(400);
    vi.spyOn(push, 'enabled', 'get').mockReturnValue(false);
    expect((await t.http.get('/api/push/vapid-key').set(bob.auth)).status).toBe(404);
    expect(
      (await t.http.post('/api/push/subscribe').set(bob.auth).send(subscription(pushOrigin())))
        .status,
    ).toBe(404);
  });

  it('stores devices per person, lists them without their address, and forgets them', async () => {
    const sub = subscription(pushOrigin());
    const saved = await t.http
      .post('/api/push/subscribe')
      .set(bob.auth)
      .send({ ...sub, userAgent: 'Test Browser' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ userAgent: 'Test Browser', service: '127.0.0.1' });
    expect(JSON.stringify(saved.body)).not.toContain(sub.endpoint);
    expect((await t.http.post('/api/push/subscribe').set(bob.auth).send(sub)).status).toBe(201); // again: the same device
    expect((await t.http.get('/api/push/devices').set(bob.auth)).body).toHaveLength(1);
    expect((await t.http.get('/api/push/devices').set(carol.auth)).body).toEqual([]);
    expect((await t.http.delete(`/api/push/devices/${saved.body.id}`).set(carol.auth)).status).toBe(
      404,
    );
    // a browser that is signed in as somebody else now belongs to them
    expect((await t.http.post('/api/push/subscribe').set(carol.auth).send(sub)).status).toBe(201);
    expect((await t.http.get('/api/push/devices').set(bob.auth)).body).toEqual([]);
    expect(
      (await t.http.delete('/api/push/subscribe').set(carol.auth).send({ endpoint: sub.endpoint }))
        .status,
    ).toBe(204);
    expect(await t.prisma.pushSubscription.count()).toBe(0);
    // at most a handful of devices
    for (let i = 0; i < 10; i++)
      expect(
        (await t.http.post('/api/push/subscribe').set(bob.auth).send(subscription(pushOrigin())))
          .status,
      ).toBe(201);
    expect(
      (await t.http.post('/api/push/subscribe').set(bob.auth).send(subscription(pushOrigin())))
        .status,
    ).toBe(409);
  });

  it('is sent to the devices of a mentioned person, and a device the service has dropped is forgotten', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    await t.http.post('/api/push/subscribe').set(bob.auth).send(subscription(pushOrigin()));
    await t.http.post('/api/push/subscribe').set(carol.auth).send(subscription(pushOrigin()));
    await sendOk(alice, ch.id, `psst ${mentionUser(bob)}`);
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0]!.path).toMatch(/^\/push\//);

    // switched off by the person
    await setting(bob, { scopeKind: 'global', push: false });
    await sendOk(alice, ch.id, `again ${mentionUser(bob)}`);
    await sleep(200);
    expect(pushed).toHaveLength(1);
    await setting(bob, { scopeKind: 'global', push: null });

    // gone: 410 removes the subscription
    pushStatus = 410;
    await sendOk(alice, ch.id, `third ${mentionUser(bob)}`);
    await vi.waitFor(async () =>
      expect(await t.prisma.pushSubscription.count({ where: { userId: bob.id } })).toBe(0),
    );
    expect(await t.prisma.pushSubscription.count({ where: { userId: carol.id } })).toBe(1);
  });

  it("carries the message, or nothing of it when the channel hides previews, in the person's language", async () => {
    const team = await newTeam();
    const open = await newChannel(owner, team.spaceId, { name: 'open' });
    const hidden = await newChannel(owner, team.spaceId, { name: 'hidden', redactPreviews: true });
    const adult = await newChannel(owner, team.spaceId, { name: 'adult', nsfw: true });
    await t.http.patch('/api/me').set(bob.auth).send({ locale: 'pt' });
    await t.http.post('/api/push/subscribe').set(bob.auth).send(subscription(pushOrigin()));
    const push = t.app.get(PushService);
    const payloads: PushPayload[] = [];
    vi.spyOn(push, 'notify').mockImplementation(async (_user, _channel, build) => {
      payloads.push(build('pt'), build('en'));
      return 1;
    });
    await sendOk(alice, open.id, `the secret plan ${mentionUser(bob)}`);
    await sendOk(alice, hidden.id, `the secret plan ${mentionUser(bob)}`);
    await sendOk(alice, adult.id, `the secret plan ${mentionUser(bob)}`);
    await vi.waitFor(() => expect(payloads).toHaveLength(6));
    const [openPt, openEn, hiddenPt, hiddenEn, adultPt] = payloads.map((p) => p.notification);
    expect(openEn!.body).toContain('the secret plan');
    expect(openEn!.title).toBe('#open · Notifiers');
    expect(openEn!.data.url).toMatch(new RegExp(`/app/c/${open.id}$`));
    expect(openEn!.data.onActionClick.default).toEqual({
      operation: 'navigateLastFocusedOrOpen',
      url: openEn!.data.url,
    });
    expect(openPt!.title).toBe('#open · Notifiers');
    for (const n of [hiddenPt, hiddenEn, adultPt]) {
      expect(JSON.stringify(n)).not.toContain('secret plan');
      expect(JSON.stringify(n)).not.toContain('plan');
    }
    expect(hiddenEn!.body).toBe('Test mentioned you');
    expect(hiddenPt!.body).toBe('Test mencionou-o');
  });

  it('is not sent while the person is looking at the channel, in quiet hours, or twice in a row', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    await t.http.post('/api/push/subscribe').set(bob.auth).send(subscription(pushOrigin()));
    const push = t.app.get(PushService);
    const socket = await connect(url, bob);
    await new Promise((r) =>
      socket.timeout(2000).emit('presence:activity', { active: true, focus: ch.id }, r),
    );
    expect(await push.isFocused(bob.id, ch.id)).toBe(true);
    expect(await push.isFocused(bob.id, uuid())).toBe(false);
    await sendOk(alice, ch.id, `watching ${mentionUser(bob)}`);
    await sleep(250);
    expect(pushed).toHaveLength(0);
    await new Promise((r) => socket.timeout(2000).emit('presence:activity', { focus: null }, r));
    expect(await push.isFocused(bob.id, ch.id)).toBe(false);
    // quiet hours hold it back (every hour of the day, so the test does not depend on the clock)
    await t.http
      .put('/api/notifications/quiet-hours')
      .set(bob.auth)
      .send({
        enabled: true,
        from: '00:00',
        to: '23:59',
        days: [0, 1, 2, 3, 4, 5, 6],
        timeZone: 'UTC',
      });
    await sendOk(alice, ch.id, `night ${mentionUser(bob)}`);
    await sleep(250);
    expect(pushed).toHaveLength(0);
    expect(await kindsOf(bob)).toEqual(['mention_user', 'mention_user']); // the inbox is not held back
    await t.http
      .put('/api/notifications/quiet-hours')
      .set(bob.auth)
      .send({ enabled: false, from: '00:00', to: '23:59', days: [], timeZone: 'UTC' });

    // coalescing: with a pause configured, a second message right after is not pushed
    const env = (push as unknown as { env: { NOTIFY_PUSH_COALESCE_SECONDS: number } }).env;
    env.NOTIFY_PUSH_COALESCE_SECONDS = 10;
    try {
      await sendOk(alice, ch.id, `one ${mentionUser(bob)}`);
      await vi.waitFor(() => expect(pushed).toHaveLength(1));
      await sendOk(alice, ch.id, `two ${mentionUser(bob)}`);
      await sleep(250);
      expect(pushed).toHaveLength(1);
    } finally {
      env.NOTIFY_PUSH_COALESCE_SECONDS = 0;
    }
  });
});

// ------------------------------------------------------------------ email

describe('email', () => {
  const digest = () => t.app.get(DigestService);
  const mails = (to: Account) =>
    t.mail.sent.filter((m) => m.kind === 'digest' && m.to === to.email);

  it('mails only mentions with `mentions`, everything with `all`, nothing with `off`', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    await setting(bob, { scopeKind: 'channel', scopeId: ch.id, email: 'mentions' });
    await setting(carol, { scopeKind: 'channel', scopeId: ch.id, email: 'all' });
    await setting(dave, { scopeKind: 'channel', scopeId: ch.id, email: 'off' });
    await sendOk(alice, ch.id, 'nobody in particular');
    await sendOk(alice, ch.id, `for you ${mentionUser(bob)}`);
    expect(await digest().flush()).toBe(2);
    expect(mails(bob)).toHaveLength(1);
    expect(mails(bob)[0]!.digest).toMatchObject({ count: 1, where: '#general', team: 'Notifiers' });
    expect(mails(bob)[0]!.digest!.lines.map((l) => l.text)).toEqual([
      expect.stringContaining('for you'),
    ]);
    expect(mails(carol)).toHaveLength(1);
    expect(mails(carol)[0]!.digest).toMatchObject({ count: 2 });
    expect(mails(dave)).toHaveLength(0);
    expect(mails(alice)).toHaveLength(0);
    expect(mails(owner)).toHaveLength(0);
    // email does not need notifications: bob's level is the default, carol never asked for push
    expect(await kindsOf(carol)).toEqual([]);
  });

  it('batches: one mail per chat per 15 minutes with the count, and nothing for what was read or deleted', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    await setting(carol, { scopeKind: 'channel', scopeId: ch.id, email: 'all' });
    const base = Date.now();
    await sendOk(alice, ch.id, 'one');
    expect(await digest().flush(base)).toBe(1);
    const second = await sendOk(alice, ch.id, 'two');
    const third = await sendOk(alice, ch.id, 'three');
    expect(await digest().flush(base + 5 * 60_000)).toBe(0); // too soon
    expect(mails(carol)).toHaveLength(1);
    expect(await digest().flush(base + 16 * 60_000)).toBe(1);
    expect(mails(carol)).toHaveLength(2);
    expect(mails(carol)[1]!.digest).toMatchObject({ count: 2 });
    // what carol read or what was deleted is not worth a mail
    await sendOk(alice, ch.id, 'four');
    const five = await sendOk(alice, ch.id, 'five');
    await t.http.put(`/api/channels/${ch.id}/read`).set(carol.auth).send({ messageId: five.id });
    expect(await digest().flush(base + 40 * 60_000)).toBe(0);
    expect(mails(carol)).toHaveLength(2);
    expect([second.id, third.id]).toHaveLength(2);
    const six = await sendOk(alice, ch.id, 'six');
    await t.http.delete(`/api/messages/${six.id}`).set(alice.auth);
    expect(await digest().flush(base + 60 * 60_000)).toBe(0);
    // many messages: the last few are listed, with how many more
    for (let i = 0; i < 8; i++) await sendOk(alice, ch.id, `bulk ${i}`);
    expect(await digest().flush(base + 80 * 60_000)).toBe(1);
    expect(mails(carol)[2]!.digest).toMatchObject({ count: 8, more: 3 });
    expect(mails(carol)[2]!.digest!.lines).toHaveLength(5);
  });

  it('waits for the person to be away, when they asked for that, and never during quiet hours', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    await setting(bob, { scopeKind: 'channel', scopeId: ch.id, email: 'mentions' });
    const socket = await connect(url, bob);
    await sendOk(alice, ch.id, `are you there ${mentionUser(bob)}`);
    expect(await digest().flush()).toBe(0); // a page of theirs was just used
    expect(await digest().flush(Date.now() + 11 * 60_000)).toBe(1); // ten minutes of silence: away
    socket.disconnect();
    // "only when away" off: even with the page open
    await setting(bob, { scopeKind: 'channel', scopeId: ch.id, emailOnlyWhenAway: false });
    const open = await connect(url, bob);
    await sendOk(alice, ch.id, `second ${mentionUser(bob)}`);
    expect(await digest().flush(Date.now() + 30 * 60_000)).toBe(1);
    open.disconnect();
    // quiet hours
    await t.http
      .put('/api/notifications/quiet-hours')
      .set(bob.auth)
      .send({
        enabled: true,
        from: '00:00',
        to: '23:59',
        days: [0, 1, 2, 3, 4, 5, 6],
        timeZone: 'UTC',
      });
    await sendOk(alice, ch.id, `third ${mentionUser(bob)}`);
    expect(await digest().flush(Date.now() + 60 * 60_000)).toBe(0);
    expect(mails(bob)).toHaveLength(2);
  });

  it("uses the person's language and carries working links, with no attachments", async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId, { name: 'news' });
    await t.http.patch('/api/me').set(bob.auth).send({ locale: 'pt' });
    await setting(bob, { scopeKind: 'channel', scopeId: ch.id, email: 'all' });
    await sendOk(alice, ch.id, 'ola');
    await digest().flush();
    const mail = mails(bob)[0]!;
    expect(mail.locale).toBe('pt');
    expect(mail.digest!.openUrl).toMatch(new RegExp(`/app/c/${ch.id}$`));
    const { digestMail } = await import('../src/mail/templates.js');
    const content = digestMail('pt', 'Bob', mail.digest!);
    expect(content.subject).toBe('Nova mensagem em #news');
    expect(content.html).toContain('Abrir a conversa');
    expect(content.headers?.['List-Unsubscribe']).toContain('/mail/action?token=');
    // a channel that hides previews does not put the text in the mail
    await t.http.patch(`/api/channels/${ch.id}`).set(owner.auth).send({ redactPreviews: true });
    await sendOk(alice, ch.id, 'hidden words');
    await digest().flush(Date.now() + 20 * 60_000);
    expect(JSON.stringify(mails(bob)[1]!.digest)).not.toContain('hidden words');
  });

  it('can be switched off from the mail itself, without a login, for that chat only', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const other = await newChannel(owner, team.spaceId, { name: 'other' });
    for (const c of [ch, other])
      await setting(bob, { scopeKind: 'channel', scopeId: c.id, email: 'all' });
    await sendOk(alice, ch.id, 'one');
    await sendOk(alice, other.id, 'one');
    await digest().flush();
    expect(mails(bob)).toHaveLength(2);
    const link = mails(bob).find((m) => m.digest!.openUrl.endsWith(ch.id))!.digest!;
    const token = (url: string): string =>
      decodeURIComponent(new URL(url).searchParams.get('token')!);

    await sendOk(alice, ch.id, 'two'); // waiting
    const res = await t.http
      .post('/api/mail/unsubscribe')
      .send({ token: token(link.unsubscribeUrl) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: 'unsubscribe', scopeKind: 'channel', scopeName: 'general' });
    // idempotent, and only that chat
    expect(
      (await t.http.post('/api/mail/unsubscribe').send({ token: token(link.unsubscribeUrl) }))
        .status,
    ).toBe(200);
    expect(await effective(bob, 'channel', ch.id)).toMatchObject({ email: 'off' });
    expect(await effective(bob, 'channel', other.id)).toMatchObject({ email: 'all' });
    expect(await digest().flush(Date.now() + 20 * 60_000)).toBe(0); // what was waiting is dropped too

    // the mute link mutes it
    const muted = await t.http.post('/api/mail/unsubscribe').send({ token: token(link.muteUrl) });
    expect(muted.body.action).toBe('mute');
    expect(await effective(bob, 'channel', ch.id)).toMatchObject({ muted: true });
    // bad, tampered and expired links are the same refusal
    for (const bad of [
      'x'.repeat(40),
      `${token(link.unsubscribeUrl)}x`,
      token(link.unsubscribeUrl).replace(/.$/, 'A'),
    ]) {
      const r = await t.http.post('/api/mail/unsubscribe').send({ token: bad });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe('invalid_link');
    }
    // a link past its 60 days
    const { SignJWT } = await import('jose');
    const key = createSecretKey(Buffer.from(process.env.JWT_MEDIA_SECRET!, 'utf8'));
    const old = await new SignJWT({ act: 'unsubscribe', sk: 'channel', si: ch.id })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(bob.id)
      .setAudience('mail-action')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 70 * 86_400)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10 * 86_400)
      .sign(key);
    expect((await t.http.post('/api/mail/unsubscribe').send({ token: old })).status).toBe(400);
    // a token for another purpose is not accepted: the media key is shared, so the audience matters
    const media = (await t.http.post('/api/auth/media-token').set(bob.auth)).body.token as string;
    expect((await t.http.post('/api/mail/unsubscribe').send({ token: media })).status).toBe(400);
  });
});
