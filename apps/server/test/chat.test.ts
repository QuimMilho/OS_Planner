import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Permission,
  permissionsToString,
  type ChannelDto,
  type MessageDto,
  type MessagePageDto,
} from '@os-planner/shared';
import { CHAT_LIMITS } from '@os-planner/shared/chat';
import { MaintenanceService } from '../src/media/maintenance.service.js';
import { StorageService } from '../src/media/storage.service.js';
import { ChatMaintenance } from '../src/chat/chat.maintenance.js';
import { createTestApp, type TestApp } from './app.js';
import { brokenPng, html, png } from './fixtures.js';
import { personalSpaceId, signup, usedBytes, uuid, uuidv7, type Account } from './helpers.js';
import { ack, closeSockets, collect, connect, listen, sleep } from './sockets.js';

const P = Permission;
const ADMIN_EMAIL = `chat-admin${Date.now()}@example.com`;
/** What a moderator holds on top of the defaults (view, send and read history). */
const CHAT_BITS =
  P.ATTACH_FILES |
  P.ADD_REACTIONS |
  P.CREATE_THREADS |
  P.SEND_IN_THREADS |
  P.MANAGE_MESSAGES |
  P.MANAGE_CHANNELS;

let t: TestApp;
let url: string;
let saved: string | undefined;
let admin: Account;
let owner: Account;
let member: Account;
let other: Account;
let outsider: Account;

beforeAll(async () => {
  saved = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  t = await createTestApp();
  url = await listen(t);
});
afterAll(async () => {
  closeSockets();
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
  other = await signup(t);
  outsider = await signup(t);
});
afterEach(() => closeSockets());

// ------------------------------------------------------------------ helpers

interface Team {
  id: string;
  spaceId: string;
}

async function newTeam(members: Account[] = [member, other]): Promise<Team> {
  const res = await t.http
    .post('/api/admin/teams')
    .set(admin.auth)
    .send({ name: 'Chatters', ownerEmail: owner.email });
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

const send = (who: Account, channelId: string, content = 'hello', extra: object = {}) =>
  t.http
    .post(`/api/channels/${channelId}/messages`)
    .set(who.auth)
    .send({ id: uuidv7(), content, ...extra });

const sendOk = async (
  who: Account,
  channelId: string,
  content = 'hello',
  extra: object = {},
): Promise<MessageDto> => {
  const res = await send(who, channelId, content, extra);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as MessageDto;
};

const list = (who: Account, channelId: string, query: object = {}) =>
  t.http.get(`/api/channels/${channelId}/messages`).set(who.auth).query(query);

const overwrite = (
  who: Account,
  channelId: string,
  subject: Account,
  allow: bigint,
  deny: bigint,
) =>
  t.http
    .put('/api/overwrites')
    .set(who.auth)
    .send({
      targetKind: 'channel',
      targetId: channelId,
      subjectKind: 'member',
      subjectId: subject.id,
      allow: permissionsToString(allow),
      deny: permissionsToString(deny),
    });

/** Gives `who` a team role with `bits` (no audit-relevant detail: the roles themselves are tested elsewhere). */
async function giveRole(
  team: Team,
  who: Account,
  bits: bigint,
  name = `role${Math.random().toString(36).slice(2, 8)}`,
): Promise<string> {
  const res = await t.http
    .post(`/api/teams/${team.id}/roles`)
    .set(owner.auth)
    .send({ name, permissions: permissionsToString(bits) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const put = await t.http
    .put(`/api/teams/${team.id}/members/${who.id}/roles/${res.body.id}`)
    .set(owner.auth);
  expect(put.status, JSON.stringify(put.body)).toBe(204);
  return res.body.id as string;
}

const upload = (
  who: Account,
  channelId: string,
  file: Buffer,
  filename = 'picture.png',
  fields: Record<string, string> = {},
) => {
  const req = t.http
    .post(`/api/channels/${channelId}/attachments`)
    .set(who.auth)
    .field('id', fields['id'] ?? uuid());
  for (const [k, v] of Object.entries(fields)) if (k !== 'id') req.field(k, v);
  return req.attach('file', file, { filename });
};

// ------------------------------------------------------------------ channels

describe('channels', () => {
  it('are created by whoever may manage channels, listed to those who can see them, and sorted by position', async () => {
    const team = await newTeam();
    const a = await newChannel(owner, team.spaceId, { name: 'announcements', topic: 'Read me' });
    const b = await newChannel(owner, team.spaceId, { name: 'random' });
    expect(a.permissions).toBeTruthy();
    expect(a.position < b.position).toBe(true);

    expect(
      (
        await t.http
          .post(`/api/spaces/${team.spaceId}/channels`)
          .set(member.auth)
          .send({ name: 'mine' })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.http
          .post(`/api/spaces/${team.spaceId}/channels`)
          .set(outsider.auth)
          .send({ name: 'mine' })
      ).status,
    ).toBe(404);
    expect(
      (await t.http.get(`/api/spaces/${team.spaceId}/channels`).set(outsider.auth)).status,
    ).toBe(404);
    // A personal space has no chat.
    expect(
      (
        await t.http
          .get(`/api/spaces/${await personalSpaceId(t, member.id)}/channels`)
          .set(member.auth)
      ).status,
    ).toBe(404);

    const seen = (await t.http.get(`/api/spaces/${team.spaceId}/channels`).set(member.auth))
      .body as ChannelDto[];
    expect(seen.map((c) => c.name)).toEqual(['announcements', 'random']);
    expect(seen[0]!.topic).toBe('Read me');
    // The same id again is the same channel.
    const again = await t.http
      .post(`/api/spaces/${team.spaceId}/channels`)
      .set(owner.auth)
      .send({ id: a.id, name: 'announcements' });
    expect(again.status).toBe(201);
    expect(await t.prisma.channel.count({ where: { spaceId: team.spaceId } })).toBe(2);
  });

  it('can sit in categories; a category is shown to people who see a channel in it, and moving channels is one call', async () => {
    const team = await newTeam();
    const cat = await newChannel(owner, team.spaceId, { name: 'Projects', kind: 'category' });
    const inside = await newChannel(owner, team.spaceId, { name: 'rockets', parentId: cat.id });
    expect(
      (
        await t.http
          .post(`/api/spaces/${team.spaceId}/channels`)
          .set(owner.auth)
          .send({ name: 'x', kind: 'category', parentId: cat.id })
      ).status,
    ).toBe(422);
    expect(
      (
        await t.http
          .post(`/api/spaces/${team.spaceId}/channels`)
          .set(owner.auth)
          .send({ name: 'x', parentId: inside.id })
      ).status,
    ).toBe(422); // not a category
    expect(
      (
        await t.http
          .post(`/api/spaces/${team.spaceId}/channels`)
          .set(owner.auth)
          .send({ name: 'v', kind: 'voice' })
      ).status,
    ).toBe(422); // voice is not configured in this test

    // Hiding the channel from a member leaves it out of their list.
    expect((await overwrite(owner, inside.id, member, 0n, P.VIEW_CHANNEL)).status).toBe(200);
    const memberSees = (await t.http.get(`/api/spaces/${team.spaceId}/channels`).set(member.auth))
      .body as ChannelDto[];
    expect(memberSees.map((c) => c.name)).toEqual(['Projects']); // the category itself is theirs to see; the channel in it is not
    const ownerSees = (await t.http.get(`/api/spaces/${team.spaceId}/channels`).set(owner.auth))
      .body as ChannelDto[];
    expect(ownerSees.map((c) => c.name).sort()).toEqual(['Projects', 'rockets']);

    const top = await newChannel(owner, team.spaceId, { name: 'top' });
    const moved = await t.http
      .put(`/api/spaces/${team.spaceId}/channels/order`)
      .set(owner.auth)
      .send({
        items: [
          { id: top.id, parentId: cat.id, position: 'a0' },
          { id: inside.id, parentId: null, position: 'a1' },
        ],
      });
    expect(moved.status).toBe(204);
    expect((await t.prisma.channel.findUniqueOrThrow({ where: { id: top.id } })).parentId).toBe(
      cat.id,
    );
    expect(
      (await t.prisma.channel.findUniqueOrThrow({ where: { id: inside.id } })).parentId,
    ).toBeNull();
  });

  it('are renamed, archived (no more messages) and deleted with everything in them; the space gets its bytes back', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const attach = await upload(owner, ch.id, await png());
    expect(attach.status, JSON.stringify(attach.body)).toBe(201);
    await sendOk(owner, ch.id, 'with picture', { attachmentIds: [attach.body.id] });
    const spaceBefore = await t.prisma.space.findUniqueOrThrow({ where: { id: team.spaceId } });
    expect(Number(spaceBefore.storageUsedBytes)).toBeGreaterThan(0);
    const media = await t.prisma.media.findUniqueOrThrow({ where: { id: attach.body.mediaId } });
    const filePath = t.app.get(StorageService).mediaPath(media.userId, media.id);
    expect(existsSync(filePath)).toBe(true);

    expect(
      (await t.http.patch(`/api/channels/${ch.id}`).set(member.auth).send({ name: 'nope' })).status,
    ).toBe(403);
    const renamed = await t.http
      .patch(`/api/channels/${ch.id}`)
      .set(owner.auth)
      .send({ name: 'lobby', topic: 'Welcome', slowmodeSeconds: 0 });
    expect(renamed.body).toMatchObject({ name: 'lobby', topic: 'Welcome' });

    expect(
      (await t.http.patch(`/api/channels/${ch.id}`).set(owner.auth).send({ archived: true })).body
        .archived,
    ).toBe(true);
    const refused = await send(owner, ch.id);
    expect(refused.status).toBe(409);
    expect(
      (await t.http.patch(`/api/channels/${ch.id}`).set(owner.auth).send({ archived: false })).body
        .archived,
    ).toBe(false);

    expect((await t.http.delete(`/api/channels/${ch.id}`).set(member.auth)).status).toBe(403);
    expect((await t.http.delete(`/api/channels/${ch.id}`).set(owner.auth)).status).toBe(204);
    expect(await t.prisma.message.count({ where: { channelId: ch.id } })).toBe(0);
    expect(await t.prisma.attachment.count({ where: { channelId: ch.id } })).toBe(0);
    expect(
      await t.prisma.overwrite.count({ where: { targetKind: 'channel', targetId: ch.id } }),
    ).toBe(0);
    expect(existsSync(filePath)).toBe(false);
    expect(
      Number(
        (await t.prisma.space.findUniqueOrThrow({ where: { id: team.spaceId } })).storageUsedBytes,
      ),
    ).toBe(0);
    expect((await t.http.get(`/api/channels/${ch.id}`).set(owner.auth)).status).toBe(404);
  });

  it('exist in project spaces too: only people who can see the project can see its channels', async () => {
    const team = await newTeam();
    const pr = await t.http
      .post(`/api/teams/${team.id}/projects`)
      .set(owner.auth)
      .send({ name: 'Secret', parentId: null, position: 'a0' });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const project = await t.prisma.project.findUniqueOrThrow({ where: { id: pr.body.id } });
    await t.prisma.projectMember.create({ data: { projectId: project.id, userId: member.id } });

    const ch = await newChannel(owner, project.spaceId, { name: 'project-chat' });
    expect((await send(member, ch.id)).status).toBe(201);
    expect((await send(other, ch.id)).status).toBe(404); // in the team, not in the project
    expect(
      (await t.http.get(`/api/spaces/${project.spaceId}/channels`).set(other.auth)).status,
    ).toBe(404);
    expect(
      (await t.http.get(`/api/spaces/${project.spaceId}/channels`).set(member.auth)).body,
    ).toHaveLength(1);
  });
});

describe('the whole team at once', () => {
  it('lists the channels of the team and of every project the person can see, each with its space, and counts unread across them', async () => {
    const team = await newTeam();
    const pr = await t.http
      .post(`/api/teams/${team.id}/projects`)
      .set(owner.auth)
      .send({ name: 'Rockets', parentId: null, position: 'a0' });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const project = await t.prisma.project.findUniqueOrThrow({ where: { id: pr.body.id } });
    await t.prisma.projectMember.create({ data: { projectId: project.id, userId: member.id } });

    const general = await newChannel(owner, team.spaceId, { name: 'general' });
    const inProject = await newChannel(owner, project.spaceId, { name: 'launch' });
    const secret = await newChannel(owner, team.spaceId, { name: 'staff' });
    await overwrite(owner, secret.id, member, 0n, P.VIEW_CHANNEL);
    await sendOk(owner, general.id, 'one');
    await sendOk(owner, inProject.id, 'two');
    await sendOk(owner, secret.id, 'three');

    const seen = (await t.http.get(`/api/teams/${team.id}/channels`).set(member.auth))
      .body as ChannelDto[];
    expect(seen.map((c) => [c.name, c.spaceId]).sort()).toEqual(
      [
        ['general', team.spaceId],
        ['launch', project.spaceId],
      ].sort(),
    );
    // a person who is in the team but not in the project sees only the team's own
    const only = (await t.http.get(`/api/teams/${team.id}/channels`).set(other.auth))
      .body as ChannelDto[];
    expect(only.map((c) => c.name).sort()).toEqual(['general', 'staff']); // not hidden from them, and not the project's
    expect((await t.http.get(`/api/teams/${team.id}/channels`).set(outsider.auth)).status).toBe(
      404,
    );

    const unread = (await t.http.get(`/api/teams/${team.id}/unread`).set(member.auth)).body as {
      channelId: string;
      unread: number;
    }[];
    expect(Object.fromEntries(unread.map((u) => [u.channelId, u.unread]))).toEqual({
      [general.id]: 1,
      [inProject.id]: 1,
    });
    expect((await t.http.get(`/api/teams/${team.id}/unread`).set(outsider.auth)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ the permission matrix

interface Op {
  name: string;
  /** The permission that decides it, or null when only seeing the channel matters. */
  bit: bigint;
  /** 404 instead of 403 when the permission is missing (seeing the channel itself). */
  hidden?: boolean;
  ok: number[];
  run(who: Account, ctx: Ctx): Promise<{ status: number }>;
}
interface Ctx {
  team: Team;
  channel: ChannelDto;
  /** A message by the owner. */
  msg: MessageDto;
  thread: string;
}

/** One table drives every case: allowed, denied (403, or 404 when it is about seeing), and not a member (404). */
const OPS: Op[] = [
  {
    name: 'list messages',
    bit: P.VIEW_CHANNEL,
    hidden: true,
    ok: [200],
    run: (w, c) => list(w, c.channel.id),
  },
  {
    name: 'read the pins',
    bit: P.VIEW_CHANNEL,
    hidden: true,
    ok: [200],
    run: (w, c) => t.http.get(`/api/channels/${c.channel.id}/pins`).set(w.auth),
  },
  {
    name: 'search',
    bit: P.VIEW_CHANNEL,
    hidden: true,
    ok: [200],
    run: (w, c) =>
      t.http.get(`/api/channels/${c.channel.id}/search`).set(w.auth).query({ q: 'hello' }),
  },
  {
    name: 'mark as read',
    bit: P.VIEW_CHANNEL,
    hidden: true,
    ok: [204],
    run: (w, c) =>
      t.http.put(`/api/channels/${c.channel.id}/read`).set(w.auth).send({ messageId: c.msg.id }),
  },
  {
    name: 'read a thread',
    bit: P.VIEW_CHANNEL,
    hidden: true,
    ok: [200],
    run: (w, c) => t.http.get(`/api/threads/${c.thread}/messages`).set(w.auth),
  },
  { name: 'send a message', bit: P.SEND_MESSAGES, ok: [201], run: (w, c) => send(w, c.channel.id) },
  {
    name: 'send in a thread',
    bit: P.SEND_IN_THREADS,
    ok: [201],
    run: (w, c) => send(w, c.channel.id, 'in thread', { threadId: c.thread }),
  },
  {
    name: 'attach a file',
    bit: P.ATTACH_FILES,
    ok: [201],
    run: async (w, c) => upload(w, c.channel.id, await png()),
  },
  {
    name: 'react',
    bit: P.ADD_REACTIONS,
    ok: [204],
    run: (w, c) =>
      t.http.put(`/api/messages/${c.msg.id}/reactions/${encodeURIComponent('👍')}`).set(w.auth),
  },
  {
    name: 'start a thread',
    bit: P.CREATE_THREADS,
    ok: [201],
    run: async (w, c) =>
      t.http
        .post(`/api/messages/${(await sendOk(owner, c.channel.id, 'another root')).id}/thread`)
        .set(w.auth)
        .send({ name: 'Side talk' }),
  },
  {
    name: 'pin',
    bit: P.MANAGE_MESSAGES,
    ok: [200],
    run: (w, c) => t.http.put(`/api/messages/${c.msg.id}/pin`).set(w.auth),
  },
  {
    name: 'delete somebody else’s message',
    bit: P.MANAGE_MESSAGES,
    ok: [204],
    run: (w, c) => t.http.delete(`/api/messages/${c.msg.id}`).set(w.auth),
  },
  {
    name: 'rename the channel',
    bit: P.MANAGE_CHANNELS,
    ok: [200],
    run: (w, c) => t.http.patch(`/api/channels/${c.channel.id}`).set(w.auth).send({ topic: 'new' }),
  },
  {
    name: 'create a channel',
    bit: P.MANAGE_CHANNELS,
    ok: [201],
    run: (w, c) =>
      t.http
        .post(`/api/spaces/${c.team.spaceId}/channels`)
        .set(w.auth)
        .send({ name: `c${uuid().slice(0, 6)}` }),
  },
  {
    name: 'delete the channel',
    bit: P.MANAGE_CHANNELS,
    ok: [204],
    run: (w, c) => t.http.delete(`/api/channels/${c.channel.id}`).set(w.auth),
  },
];

describe('permission matrix', () => {
  for (const op of OPS) {
    it(`${op.name}: allowed, denied without ${Object.entries(P).find(([, v]) => v === op.bit)![0]}, and 404 for non-members`, async () => {
      const team = await newTeam();
      await giveRole(team, member, CHAT_BITS);
      const make = async (): Promise<Ctx> => {
        const channel = await newChannel(owner, team.spaceId, { name: `c${uuid().slice(0, 6)}` });
        const msg = await sendOk(owner, channel.id, 'hello world');
        const root = await sendOk(owner, channel.id, 'thread root');
        const th = await t.http
          .post(`/api/messages/${root.id}/thread`)
          .set(owner.auth)
          .send({ name: 'Talk' });
        expect(th.status, JSON.stringify(th.body)).toBe(201);
        return { team, channel, msg, thread: th.body.id };
      };

      // allowed
      const allowed = await make();
      const yes = await op.run(member, allowed);
      expect(op.ok, `${op.name} allowed -> ${yes.status}`).toContain(yes.status);

      // denied: the same person with that one permission taken away on the channel
      const denied = await make();
      if (op.name === 'create a channel') {
        // decided in the team, not in a channel: somebody without the role is refused
        expect((await op.run(other, denied)).status, `${op.name} denied`).toBe(403);
      } else {
        expect((await overwrite(owner, denied.channel.id, member, 0n, op.bit)).status).toBe(200);
        expect((await op.run(member, denied)).status, `${op.name} denied`).toBe(
          op.hidden ? 404 : 403,
        );
      }

      // not a member of the team
      const away = await make();
      expect((await op.run(outsider, away)).status, `${op.name} outsider`).toBe(404);
    });
  }

  it('lets a channel overwrite give what the role does not, and a role-level deny be undone for one member', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    expect(
      (
        await t.http
          .put(
            `/api/messages/${(await sendOk(owner, ch.id)).id}/reactions/${encodeURIComponent('👍')}`,
          )
          .set(member.auth)
      ).status,
    ).toBe(403);
    expect((await overwrite(owner, ch.id, member, P.ADD_REACTIONS, 0n)).status).toBe(200);
    const msg = await sendOk(owner, ch.id, 'again');
    expect(
      (
        await t.http
          .put(`/api/messages/${msg.id}/reactions/${encodeURIComponent('👍')}`)
          .set(member.auth)
      ).status,
    ).toBe(204);
    // the overwrite is audited like any other
    const audit = await t.prisma.auditLog.findFirst({
      where: { teamId: team.id, action: 'overwrite.set', targetKind: 'channel' },
    });
    expect(audit?.targetId).toBe(ch.id);
  });
});

// ------------------------------------------------------------------ messages

describe('sending and paging', () => {
  it('is idempotent by id: the same message twice is stored once, and a taken id is refused', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const id = uuidv7();
    const first = await t.http
      .post(`/api/channels/${ch.id}/messages`)
      .set(member.auth)
      .send({ id, content: 'once' });
    const second = await t.http
      .post(`/api/channels/${ch.id}/messages`)
      .set(member.auth)
      .send({ id, content: 'once' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(await t.prisma.message.count({ where: { channelId: ch.id } })).toBe(1);
    // somebody else sending that id, or the id in another channel, is a conflict
    expect(
      (
        await t.http
          .post(`/api/channels/${ch.id}/messages`)
          .set(other.auth)
          .send({ id, content: 'mine' })
      ).status,
    ).toBe(409);
    const ch2 = await newChannel(owner, team.spaceId, { name: 'other' });
    expect(
      (
        await t.http
          .post(`/api/channels/${ch2.id}/messages`)
          .set(member.auth)
          .send({ id, content: 'once' })
      ).status,
    ).toBe(409);

    // at the same moment: still one
    const racing = uuidv7();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.http
          .post(`/api/channels/${ch.id}/messages`)
          .set(member.auth)
          .send({ id: racing, content: 'race' }),
      ),
    );
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await t.prisma.message.count({ where: { id: racing } })).toBe(1);
  });

  it('refuses empty and over-long text, a message that is not a v7 id, and a reply to another channel', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const ch2 = await newChannel(owner, team.spaceId, { name: 'elsewhere' });
    expect((await send(member, ch.id, '   ')).status).toBe(422);
    expect((await send(member, ch.id, 'x'.repeat(CHAT_LIMITS.messageMax + 1))).status).toBe(400);
    expect((await send(member, ch.id, 'x'.repeat(CHAT_LIMITS.messageMax))).status).toBe(201);
    expect(
      (
        await t.http
          .post(`/api/channels/${ch.id}/messages`)
          .set(member.auth)
          .send({ id: uuid(), content: 'v4 id' })
      ).status,
    ).toBe(400);
    const there = await sendOk(member, ch2.id, 'over there');
    expect((await send(member, ch.id, 'reply', { replyToId: there.id })).status).toBe(422);
  });

  it('orders by id and pages with before/after so that every message appears exactly once', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push((await sendOk(member, ch.id, `message ${i}`)).id);
    expect(ids).toEqual([...ids].sort());

    // newest page first, then older ones with `before`
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = (await list(owner, ch.id, { limit: 4, ...(cursor ? { before: cursor } : {}) }))
        .body as MessagePageDto;
      expect(page.items.map((m) => m.id)).toEqual([...page.items.map((m) => m.id)].sort());
      seen.unshift(...page.items.map((m) => m.id));
      if (!page.hasMore) break;
      cursor = page.items[0]!.id;
    }
    expect(seen).toEqual(ids);

    // forward with `after`
    const forward: string[] = [];
    let after = '00000000-0000-7000-8000-000000000000';
    for (let guard = 0; guard < 10; guard++) {
      const page = (await list(owner, ch.id, { limit: 4, after })).body as MessagePageDto;
      forward.push(...page.items.map((m) => m.id));
      if (!page.hasMore) break;
      after = page.items.at(-1)!.id;
    }
    expect(forward).toEqual(ids);
    expect((await list(owner, ch.id, { before: ids[0], after: ids[1] })).status).toBe(400);
  });

  it('lets a client that was away catch up with edits, deletions and reactions through the change sequence', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const a = await sendOk(member, ch.id, 'first');
    const b = await sendOk(member, ch.id, 'second');
    const start = (await list(owner, ch.id)).body as MessagePageDto;
    const cursor = start.lastSeq;

    await t.http
      .patch(`/api/messages/${a.id}`)
      .set(member.auth)
      .send({ content: 'first (edited)' });
    await t.http.put(`/api/messages/${b.id}/reactions/${encodeURIComponent('🎉')}`).set(owner.auth);
    const c = await sendOk(other, ch.id, 'third');
    await t.http.delete(`/api/messages/${b.id}`).set(member.auth);

    const missed = (await list(owner, ch.id, { since: cursor })).body as MessagePageDto;
    const byId = new Map(missed.items.map((m) => [m.id, m]));
    expect(byId.get(a.id)?.content).toBe('first (edited)');
    expect(byId.get(b.id)?.deletedAt).toBeTruthy(); // a tombstone, not silence
    expect(byId.get(c.id)?.content).toBe('third');
    expect(Number(missed.lastSeq)).toBeGreaterThan(Number(cursor));
    // nothing newer than what was just seen
    expect(
      ((await list(owner, ch.id, { since: missed.lastSeq })).body as MessagePageDto).items,
    ).toEqual([]);
  });

  it('keeps thread replies out of the channel list but shows the thread on its root message', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    await giveRole(team, member, CHAT_BITS);
    await giveRole(team, other, P.SEND_IN_THREADS);
    const root = await sendOk(member, ch.id, 'root');
    const th = await t.http
      .post(`/api/messages/${root.id}/thread`)
      .set(member.auth)
      .send({ name: 'Details' });
    expect(th.status).toBe(201);
    expect(
      (
        await t.http
          .post(`/api/messages/${root.id}/thread`)
          .set(member.auth)
          .send({ name: 'Second' })
      ).status,
    ).toBe(409); // one per message
    const reply = await sendOk(other, ch.id, 'a reply', { threadId: th.body.id });
    expect(reply.threadId).toBe(th.body.id);

    const channelList = (await list(owner, ch.id)).body as MessagePageDto;
    expect(channelList.items.map((m) => m.id)).toEqual([root.id]);
    expect(channelList.items[0]!.thread).toMatchObject({
      id: th.body.id,
      name: 'Details',
      replyCount: 1,
      archived: false,
    });
    const inThread = (await t.http.get(`/api/threads/${th.body.id}/messages`).set(owner.auth)).body;
    expect(inThread.items.map((m: MessageDto) => m.id)).toEqual([reply.id]);
    expect(inThread.root.id).toBe(root.id);

    // a reply cannot start a thread of its own; an archived thread takes no more messages and can be reopened
    expect(
      (
        await t.http
          .post(`/api/messages/${reply.id}/thread`)
          .set(member.auth)
          .send({ name: 'Nested' })
      ).status,
    ).toBe(404);
    expect(
      (await t.http.patch(`/api/threads/${th.body.id}`).set(other.auth).send({ archived: true }))
        .status,
    ).toBe(403);
    expect(
      (await t.http.patch(`/api/threads/${th.body.id}`).set(member.auth).send({ archived: true }))
        .body.archived,
    ).toBe(true);
    expect((await send(other, ch.id, 'late', { threadId: th.body.id })).status).toBe(409);
    expect(
      (await t.http.patch(`/api/threads/${th.body.id}`).set(member.auth).send({ archived: false }))
        .body.archived,
    ).toBe(false);
    expect((await send(other, ch.id, 'back again', { threadId: th.body.id })).status).toBe(201);
  });
});

describe('editing and deleting', () => {
  it('lets only the author edit, lets the author or a moderator delete, and leaves a tombstone that replies still point at', async () => {
    const team = await newTeam();
    await giveRole(team, other, P.MANAGE_MESSAGES);
    const ch = await newChannel(owner, team.spaceId);
    const original = await sendOk(member, ch.id, 'secret words');
    const reply = await sendOk(owner, ch.id, 'replying', { replyToId: original.id });
    expect(reply.replyTo).toMatchObject({ snippet: 'secret words', deleted: false });

    expect(
      (
        await t.http
          .patch(`/api/messages/${original.id}`)
          .set(other.auth)
          .send({ content: 'hacked' })
      ).status,
    ).toBe(403); // moderators delete, they do not edit
    expect(
      (
        await t.http
          .patch(`/api/messages/${original.id}`)
          .set(owner.auth)
          .send({ content: 'hacked' })
      ).status,
    ).toBe(403);
    const edited = await t.http
      .patch(`/api/messages/${original.id}`)
      .set(member.auth)
      .send({ content: 'fixed words' });
    expect(edited.status).toBe(200);
    expect(edited.body.editedAt).toBeTruthy();
    expect(edited.body.content).toBe('fixed words');
  });

  it('removes the text from the database and shows repliers "message deleted"', async () => {
    const team = await newTeam();
    await giveRole(team, other, P.MANAGE_MESSAGES);
    const ch = await newChannel(owner, team.spaceId);
    const original = await sendOk(member, ch.id, 'to be removed');
    const reply = await sendOk(owner, ch.id, 'replying', { replyToId: original.id });
    await t.http
      .put(`/api/messages/${original.id}/reactions/${encodeURIComponent('👍')}`)
      .set(owner.auth);

    expect((await t.http.delete(`/api/messages/${original.id}`).set(other.auth)).status).toBe(204); // a moderator
    const row = await t.prisma.message.findUniqueOrThrow({ where: { id: original.id } });
    expect(row.content).toBe('');
    expect(row.deletedAt).not.toBeNull();
    expect(await t.prisma.reaction.count({ where: { messageId: original.id } })).toBe(0);
    const page = (await list(owner, ch.id)).body as MessagePageDto;
    const replyNow = page.items.find((m) => m.id === reply.id)!;
    expect(replyNow.replyTo).toMatchObject({ deleted: true, snippet: null });
    expect(page.items.find((m) => m.id === original.id)).toMatchObject({
      content: '',
      deletedAt: expect.any(String),
    });
    // deleting again is fine; editing or reacting to a deleted message is not
    expect((await t.http.delete(`/api/messages/${original.id}`).set(member.auth)).status).toBe(204);
    expect(
      (
        await t.http
          .patch(`/api/messages/${original.id}`)
          .set(member.auth)
          .send({ content: 'back' })
      ).status,
    ).toBe(404);
  });
});

// ------------------------------------------------------------------ attachments and quota

describe('attachments', () => {
  it('are checked by their bytes, charged to the team space, shown through the channel, and refunded when the message goes', async () => {
    const team = await newTeam();
    await giveRole(team, member, CHAT_BITS);
    const ch = await newChannel(owner, team.spaceId);
    const file = await png(40, 30);

    // the type comes from the bytes, never from the name or the content type
    expect(
      (await upload(member, ch.id, Buffer.from('<script>alert(1)</script>'), 'cat.png')).status,
    ).toBe(415);
    expect((await upload(member, ch.id, html, 'cat.png')).status).toBe(415);
    expect((await upload(member, ch.id, brokenPng, 'cat.png')).status).toBe(415);
    expect(await t.prisma.attachment.count()).toBe(0);
    expect(
      Number(
        (await t.prisma.space.findUniqueOrThrow({ where: { id: team.spaceId } })).storageUsedBytes,
      ),
    ).toBe(0);

    const up = await upload(member, ch.id, file, '../../evil/picture one.png');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({
      name: 'picture one.png',
      mime: 'image/png',
      width: 40,
      height: 30,
      kind: 'image',
    });
    const used = Number(
      (await t.prisma.space.findUniqueOrThrow({ where: { id: team.spaceId } })).storageUsedBytes,
    );
    expect(used).toBe(file.length);
    expect(await usedBytes(t, member.id)).toBe(0); // the space of the team, not the person's own

    // the same upload again is the same attachment; somebody else's id is a conflict
    expect((await upload(member, ch.id, file, 'x.png', { id: up.body.id })).status).toBe(201);
    expect(await t.prisma.attachment.count()).toBe(1);
    expect((await upload(owner, ch.id, file, 'x.png', { id: up.body.id })).status).toBe(409);

    const msg = await sendOk(member, ch.id, 'look', { attachmentIds: [up.body.id] });
    expect(msg.attachments).toHaveLength(1);
    // an attachment cannot be used twice, or by someone else, or in another channel
    expect((await send(member, ch.id, 'again', { attachmentIds: [up.body.id] })).status).toBe(422);

    // the file is as visible as the channel
    const token = (await t.http.post('/api/auth/media-token').set(other.auth)).body.token as string;
    expect((await t.http.get(`/api/media/${up.body.mediaId}`).query({ t: token })).status).toBe(
      200,
    );
    await overwrite(owner, ch.id, other, 0n, P.VIEW_CHANNEL);
    expect((await t.http.get(`/api/media/${up.body.mediaId}`).query({ t: token })).status).toBe(
      404,
    );
    // ...and not the other way round: being in the team is not enough for the notebooks' media rules to apply
    const outsiderToken = (await t.http.post('/api/auth/media-token').set(outsider.auth)).body
      .token as string;
    expect(
      (await t.http.get(`/api/media/${up.body.mediaId}`).query({ t: outsiderToken })).status,
    ).toBe(404);

    // deleting the message deletes the bytes and gives the room back
    const bytes = Buffer.byteLength('look');
    expect(
      Number(
        (await t.prisma.space.findUniqueOrThrow({ where: { id: team.spaceId } })).storageUsedBytes,
      ),
    ).toBe(used + bytes);
    const media = await t.prisma.media.findUniqueOrThrow({ where: { id: up.body.mediaId } });
    const path = t.app.get(StorageService).mediaPath(media.userId, media.id);
    expect(existsSync(path)).toBe(true);
    expect((await t.http.delete(`/api/messages/${msg.id}`).set(member.auth)).status).toBe(204);
    expect(existsSync(path)).toBe(false);
    expect(
      Number(
        (await t.prisma.space.findUniqueOrThrow({ where: { id: team.spaceId } })).storageUsedBytes,
      ),
    ).toBe(0);
  });

  it('are refused when they do not fit, leaving no file and no row behind; text counts toward the limit too', async () => {
    const team = await newTeam();
    await giveRole(team, member, CHAT_BITS);
    const ch = await newChannel(owner, team.spaceId);
    const file = await png(60, 60);
    await t.prisma.quotaOverride.create({
      data: {
        id: uuid(),
        scope: 'team',
        scopeId: team.id,
        storageBytes: BigInt(file.length + 10),
        updatedBy: admin.id,
      },
    });

    const storage = t.app.get(StorageService);
    const filesBefore = await countFiles(storage);
    const first = await upload(member, ch.id, file);
    expect(first.status).toBe(201);
    const second = await upload(member, ch.id, await png(61, 61));
    expect(second.status).toBe(413);
    expect(second.body).toMatchObject({ code: 'quota_exceeded', scope: 'team' });
    expect(await t.prisma.attachment.count()).toBe(1);
    expect(await countFiles(storage)).toBe(filesBefore + 1);

    // text is counted: ten bytes of room are left, so a longer message is refused whole
    expect((await send(member, ch.id, 'x'.repeat(11))).status).toBe(413);
    expect(await t.prisma.message.count({ where: { channelId: ch.id } })).toBe(0);
    expect((await send(member, ch.id, 'x'.repeat(10))).status).toBe(201);
  });

  it('that are never sent are collected after a day, and their bytes returned', async () => {
    const team = await newTeam();
    await giveRole(team, member, CHAT_BITS);
    const ch = await newChannel(owner, team.spaceId);
    const up = await upload(member, ch.id, await png());
    expect(up.status).toBe(201);
    const media = await t.prisma.media.findUniqueOrThrow({ where: { id: up.body.mediaId } });
    const path = t.app.get(StorageService).mediaPath(media.userId, media.id);

    // the nightly cleanup of unused uploads does not touch it, nor does the one for chat before the grace period is over
    expect(
      await t.app
        .get(MaintenanceService)
        .collectOrphanMedia(new Date(Date.now() + 30 * 24 * 3600_000)),
    ).toBe(0);
    expect(await t.app.get(ChatMaintenance).collectUnsentAttachments()).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(
      await t.app
        .get(ChatMaintenance)
        .collectUnsentAttachments(new Date(Date.now() + 25 * 3600_000)),
    ).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(await t.prisma.attachment.count()).toBe(0);
    expect(
      Number(
        (await t.prisma.space.findUniqueOrThrow({ where: { id: team.spaceId } })).storageUsedBytes,
      ),
    ).toBe(0);
  });
});

async function countFiles(storage: StorageService): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let n = 0;
  for (const dir of await readdir(storage.uploads).catch(() => []))
    n += (await readdir(`${storage.uploads}/${dir}`).catch(() => [])).length;
  return n;
}

// ------------------------------------------------------------------ reactions, pins, search, history

describe('reactions', () => {
  it('are unique per message, person and emoji, counted correctly under concurrency, and removed with the message', async () => {
    const team = await newTeam();
    await giveRole(team, member, CHAT_BITS);
    await giveRole(team, other, CHAT_BITS);
    const ch = await newChannel(owner, team.spaceId);
    const msg = await sendOk(owner, ch.id, 'vote');
    const react = (who: Account, emoji: string) =>
      t.http.put(`/api/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}`).set(who.auth);

    // the same person twice is one reaction; different emoji that look alike to a case-insensitive collation are different
    expect((await react(member, '👍')).status).toBe(204);
    expect((await react(member, '👍')).status).toBe(204);
    expect((await react(member, '😂')).status).toBe(204);
    expect(await t.prisma.reaction.count({ where: { messageId: msg.id } })).toBe(2);
    expect(
      (
        await t.http
          .put(`/api/messages/${msg.id}/reactions/${encodeURIComponent('a')}`)
          .set(member.auth)
      ).status,
    ).toBe(400); // not an emoji

    // many people at once
    const crowd: Account[] = [];
    for (let i = 0; i < 8; i++) {
      const who = await signup(t);
      await t.prisma.teamMember.create({ data: { teamId: team.id, userId: who.id } });
      await giveRole(team, who, P.ADD_REACTIONS);
      crowd.push(who);
    }
    await Promise.all([
      ...crowd.map((c) => react(c, '🎉')),
      ...crowd.map((c) => react(c, '🎉')),
      react(other, '🎉'),
    ]);
    const page = (await list(owner, ch.id)).body as MessagePageDto;
    const reactions = page.items[0]!.reactions;
    expect(reactions.find((r) => r.emoji === '🎉')).toMatchObject({ count: 9 });
    expect(new Set(reactions.find((r) => r.emoji === '🎉')!.userIds).size).toBe(9);
    expect(reactions.find((r) => r.emoji === '👍')?.count).toBe(1);

    expect(
      (
        await t.http
          .delete(`/api/messages/${msg.id}/reactions/${encodeURIComponent('🎉')}`)
          .set(other.auth)
      ).status,
    ).toBe(204);
    expect(await t.prisma.reaction.count({ where: { messageId: msg.id, emoji: '🎉' } })).toBe(8);
    expect((await t.http.delete(`/api/messages/${msg.id}`).set(owner.auth)).status).toBe(204);
    expect(await t.prisma.reaction.count({ where: { messageId: msg.id } })).toBe(0);
  });
});

describe('pins', () => {
  it('are set by moderators and listed to everyone who can read the channel', async () => {
    const team = await newTeam();
    await giveRole(team, other, P.MANAGE_MESSAGES);
    const ch = await newChannel(owner, team.spaceId);
    const a = await sendOk(member, ch.id, 'important');
    await sendOk(member, ch.id, 'chatter');
    expect((await t.http.put(`/api/messages/${a.id}/pin`).set(member.auth)).status).toBe(403);
    const pinned = await t.http.put(`/api/messages/${a.id}/pin`).set(other.auth);
    expect(pinned.status).toBe(200);
    expect(pinned.body.pinnedAt).toBeTruthy();
    expect(
      ((await t.http.get(`/api/channels/${ch.id}/pins`).set(member.auth)).body as MessageDto[]).map(
        (m) => m.id,
      ),
    ).toEqual([a.id]);
    expect(
      (await t.http.delete(`/api/messages/${a.id}/pin`).set(other.auth)).body.pinnedAt,
    ).toBeNull();
    expect((await t.http.get(`/api/channels/${ch.id}/pins`).set(member.auth)).body).toEqual([]);
  });
});

describe('search', () => {
  it('finds "acentuação" by typing "acentuacao", only in the channel asked about, and not in channels the person cannot see', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const hidden = await newChannel(owner, team.spaceId, { name: 'staff' });
    await overwrite(owner, hidden.id, member, 0n, P.VIEW_CHANNEL);
    await sendOk(owner, ch.id, 'A acentuação portuguesa é difícil');
    await sendOk(owner, ch.id, 'nothing to see');
    await sendOk(owner, hidden.id, 'acentuação em segredo');

    const hit = await t.http
      .get(`/api/channels/${ch.id}/search`)
      .set(member.auth)
      .query({ q: 'acentuacao' });
    expect(hit.status).toBe(200);
    expect((hit.body as MessageDto[]).map((m) => m.content)).toEqual([
      'A acentuação portuguesa é difícil',
    ]);
    expect(
      (
        (await t.http.get(`/api/channels/${ch.id}/search`).set(member.auth).query({ q: 'ACENT' }))
          .body as MessageDto[]
      ).length,
    ).toBe(1); // prefix, any case
    expect(
      (
        await t.http
          .get(`/api/channels/${hidden.id}/search`)
          .set(member.auth)
          .query({ q: 'acentuacao' })
      ).status,
    ).toBe(404);
    expect(
      (await t.http.get(`/api/channels/${ch.id}/search`).set(member.auth).query({ q: '+-*()"<>~' }))
        .body as MessageDto[],
    ).toEqual([]);
  });
});

describe('history', () => {
  it('is only what was said after the person opened the channel when they may not read history', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    await sendOk(owner, ch.id, 'old one');
    await sendOk(owner, ch.id, 'old two');
    await overwrite(owner, ch.id, member, 0n, P.READ_MESSAGE_HISTORY);

    expect(((await list(member, ch.id)).body as MessagePageDto).items).toEqual([]); // opens the channel now
    await sleep(20);
    await sendOk(owner, ch.id, 'new one');
    const seen = ((await list(member, ch.id)).body as MessagePageDto).items.map((m) => m.content);
    expect(seen).toEqual(['new one']);
    // the old ones are not searchable, pinned-listable or editable by id either
    expect(
      (await t.http.get(`/api/channels/${ch.id}/search`).set(member.auth).query({ q: 'old' }))
        .body as MessageDto[],
    ).toEqual([]);
    const oldId = (
      await t.prisma.message.findFirstOrThrow({ where: { channelId: ch.id, content: 'old one' } })
    ).id;
    expect(
      (
        await t.http
          .put(`/api/messages/${oldId}/reactions/${encodeURIComponent('👍')}`)
          .set(member.auth)
      ).status,
    ).toBe(404);
    // a person who may read history sees everything
    expect(((await list(other, ch.id)).body as MessagePageDto).items).toHaveLength(3);
  });
});

describe('slowmode and rate', () => {
  it('lets a person send one message per interval, except moderators', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId, { slowmodeSeconds: 30 });
    expect((await send(member, ch.id)).status).toBe(201);
    const slow = await send(member, ch.id, 'too soon');
    expect(slow.status).toBe(429);
    expect(slow.body).toMatchObject({ message: 'slowmode' });
    expect(slow.body.retryAfter).toBeGreaterThan(0);
    expect((await send(other, ch.id)).status).toBe(201); // somebody else is not held back
    expect((await send(owner, ch.id)).status).toBe(201);
    expect((await send(owner, ch.id, 'again')).status).toBe(201); // moderators are exempt
  });
});

describe('read state', () => {
  it('counts what others wrote after the last message read, per channel', async () => {
    const team = await newTeam();
    const a = await newChannel(owner, team.spaceId, { name: 'a' });
    const b = await newChannel(owner, team.spaceId, { name: 'b' });
    await sendOk(member, a.id, 'one');
    const two = await sendOk(member, a.id, 'two');
    await sendOk(member, a.id, 'three');
    await sendOk(owner, b.id, 'hello');
    await sendOk(member, b.id, 'my own words');

    const counts = async (who: Account) =>
      Object.fromEntries(
        (
          (await t.http.get(`/api/spaces/${team.spaceId}/unread`).set(who.auth)).body as {
            channelId: string;
            unread: number;
          }[]
        ).map((u) => [u.channelId, u.unread]),
      );
    expect(await counts(owner)).toEqual({ [a.id]: 3, [b.id]: 1 }); // own messages do not count
    expect(await counts(member)).toEqual({ [a.id]: 0, [b.id]: 1 });

    expect(
      (await t.http.put(`/api/channels/${a.id}/read`).set(owner.auth).send({ messageId: two.id }))
        .status,
    ).toBe(204);
    expect((await counts(owner))[a.id]).toBe(1);
    // reading never moves backwards
    const first = (
      await t.prisma.message.findFirstOrThrow({ where: { channelId: a.id, content: 'one' } })
    ).id;
    await t.http.put(`/api/channels/${a.id}/read`).set(owner.auth).send({ messageId: first });
    expect((await counts(owner))[a.id]).toBe(1);
    expect(
      (await t.http.put(`/api/channels/${a.id}/read`).set(owner.auth).send({ messageId: uuidv7() }))
        .status,
    ).toBe(404);
    expect((await t.http.get(`/api/spaces/${team.spaceId}/unread`).set(outsider.auth)).status).toBe(
      404,
    );
  });
});

// ------------------------------------------------------------------ live

describe('live events', () => {
  it('reach the people in the channel room, in the order they happened, and stop for someone who loses the channel', async () => {
    const team = await newTeam();
    const ch = await newChannel(owner, team.spaceId);
    const sb = await connect(url, member);
    const so = await connect(url, owner);
    expect(await ack(sb, 'room:join', { kind: 'channel', id: ch.id })).toEqual({ ok: true });
    expect(await ack(so, 'room:join', { kind: 'channel', id: ch.id })).toEqual({ ok: true });
    const stranger = await connect(url, outsider);
    expect(await ack(stranger, 'room:join', { kind: 'channel', id: ch.id })).toEqual({ ok: false });
    expect(await ack(stranger, 'room:join', { kind: 'channel', id: uuid() })).toEqual({
      ok: false,
    });

    const created = collect<MessageDto>(sb, 'message.created');
    const updated = collect<MessageDto>(sb, 'message.updated');
    const reactions = collect<{ emoji: string }>(sb, 'reaction.added');
    const deleted = collect<{ messageId: string }>(sb, 'message.deleted');
    const strangerHears = collect(stranger, 'message.created');

    const m = await sendOk(owner, ch.id, 'live');
    await t.http.patch(`/api/messages/${m.id}`).set(owner.auth).send({ content: 'live (edited)' });
    await giveRole(team, member, P.ADD_REACTIONS);
    await t.http
      .put(`/api/messages/${m.id}/reactions/${encodeURIComponent('👍')}`)
      .set(member.auth);
    await t.http.delete(`/api/messages/${m.id}`).set(owner.auth);
    await sleep(500);
    expect(created.map((x) => x.id)).toEqual([m.id]);
    expect(updated.map((x) => x.content)).toEqual(['live (edited)']);
    expect(reactions.map((x) => x.emoji)).toEqual(['👍']);
    expect(deleted.map((x) => x.messageId)).toEqual([m.id]);
    expect(strangerHears).toEqual([]);

    // taking the channel away from member drops them from its room before the request returns
    expect((await overwrite(owner, ch.id, member, 0n, P.VIEW_CHANNEL)).status).toBe(200);
    const after = collect(sb, 'message.created');
    await sendOk(owner, ch.id, 'not for member');
    await sleep(400);
    expect(after).toEqual([]);
    expect((await list(member, ch.id)).status).toBe(404);
  });

  it('puts the replies of a thread in the thread room and only a summary in the channel room', async () => {
    const team = await newTeam();
    await giveRole(team, member, CHAT_BITS);
    const ch = await newChannel(owner, team.spaceId);
    const root = await sendOk(owner, ch.id, 'root');
    const so = await connect(url, owner);
    const sm = await connect(url, member);
    await ack(so, 'room:join', { kind: 'channel', id: ch.id });
    await ack(sm, 'room:join', { kind: 'channel', id: ch.id });
    const created = collect<{ thread: { id: string } }>(so, 'thread.created');
    const th = await t.http
      .post(`/api/messages/${root.id}/thread`)
      .set(member.auth)
      .send({ name: 'Side' });
    await sleep(300);
    expect(created).toHaveLength(1);

    expect(await ack(so, 'room:join', { kind: 'thread', id: th.body.id })).toEqual({ ok: true });
    const heard = collect<MessageDto>(so, 'message.created');
    const summaries = collect<{ thread: { replyCount: number } }>(so, 'thread.updated');
    await sendOk(member, ch.id, 'in the thread', { threadId: th.body.id });
    await sleep(400);
    expect(heard).toHaveLength(1); // once, through the thread room: the channel room only hears of the summary
    expect(heard[0]?.threadId).toBe(th.body.id);
    expect(summaries.at(-1)?.thread.replyCount).toBe(1);

    expect(
      await ack(await connect(url, outsider), 'room:join', { kind: 'thread', id: th.body.id }),
    ).toEqual({ ok: false });
  });
});
