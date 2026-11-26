import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Permission,
  permissionsToString,
  type DmDto,
  type MessageDto,
  type MessagePageDto,
} from '@os-planner/shared';
import { ChatMaintenance } from '../src/chat/chat.maintenance.js';
import { createTestApp, type TestApp } from './app.js';
import { png } from './fixtures.js';
import { personalSpaceId, signup, uuid, uuidv7, type Account } from './helpers.js';
import { ack, closeSockets, collect, connect, listen, sleep } from './sockets.js';

const ADMIN_EMAIL = `dm-admin${Date.now()}@example.com`;

let t: TestApp;
let url: string;
let saved: string | undefined;
let admin: Account;
let owner: Account;
let alice: Account;
let bob: Account;
let carol: Account;
let loner: Account;

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
  await t.prisma.channel.deleteMany({ where: { kind: 'dm' } });
  admin = await signup(t, true, ADMIN_EMAIL);
  owner = await signup(t);
  alice = await signup(t);
  bob = await signup(t);
  carol = await signup(t);
  loner = await signup(t);
});
afterEach(() => closeSockets());

// ------------------------------------------------------------------ helpers

async function newTeam(members: Account[] = [alice, bob], name = 'Chatters') {
  const res = await t.http
    .post('/api/admin/teams')
    .set(admin.auth)
    .send({ name, ownerEmail: owner.email });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const m of members)
    await t.prisma.teamMember.create({ data: { teamId: res.body.id, userId: m.id } });
  return { id: res.body.id as string };
}

const start = (who: Account, other: Account | string) =>
  t.http
    .post('/api/dms')
    .set(who.auth)
    .send({ userId: typeof other === 'string' ? other : other.id });

const startOk = async (who: Account, other: Account): Promise<DmDto> => {
  const res = await start(who, other);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as DmDto;
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

const upload = (who: Account, channelId: string, file: Buffer) =>
  t.http
    .post(`/api/channels/${channelId}/attachments`)
    .set(who.auth)
    .field('id', uuid())
    .attach('file', file, { filename: 'picture.png' });

const list = (who: Account) => t.http.get('/api/dms').set(who.auth);
const storageOf = async (userId: string): Promise<number> =>
  Number((await t.prisma.space.findUniqueOrThrow({ where: { userId } })).storageUsedBytes);

/** What a refusal looks like: the same whatever the reason. */
const refusal = { statusCode: 403, message: 'dm_not_allowed' };

// ------------------------------------------------------------------ starting

describe('starting a conversation', () => {
  it('returns the same conversation whoever starts it, and however often', async () => {
    await newTeam();
    const first = await startOk(alice, bob);
    const again = await start(alice, bob);
    const reverse = await start(bob, alice);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.id);
    expect(reverse.body.id).toBe(first.id);
    expect(reverse.body.channelId).toBe(first.channelId);
    expect(first.peer).toEqual({ id: bob.id, displayName: 'Test' });
    expect(await t.prisma.directConversation.count()).toBe(1);
    // the pair is stored in a fixed order
    const row = await t.prisma.directConversation.findFirstOrThrow();
    expect(row.userA! < row.userB!).toBe(true);
    // its channel belongs to no space
    expect(
      await t.prisma.channel.findUniqueOrThrow({ where: { id: first.channelId } }),
    ).toMatchObject({
      kind: 'dm',
      spaceId: null,
    });
  });

  it('survives two people starting it at the same moment', async () => {
    await newTeam();
    const [a, b] = await Promise.all([start(alice, bob), start(bob, alice)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await t.prisma.directConversation.count()).toBe(1);
  });

  it('needs a team in common, a verified address and a real person; every refusal looks the same', async () => {
    await newTeam([alice, bob]);
    const noTeam = await start(alice, loner);
    expect(noTeam.status).toBe(403);
    expect(noTeam.body).toMatchObject(refusal);
    // somebody who does not exist, and oneself: the same answer
    expect((await start(alice, uuid())).body).toMatchObject(refusal);
    expect((await start(alice, alice)).body).toMatchObject(refusal);
    expect((await start(alice, uuid())).status).toBe(403);
    expect(await t.prisma.directConversation.count()).toBe(0);

    const unverified = await signup(t, false);
    await t.prisma.teamMember.create({
      data: { teamId: (await t.prisma.team.findFirstOrThrow()).id, userId: unverified.id },
    });
    expect((await start(unverified, alice)).status).toBe(403);
  });

  it('is not possible when the recipient accepts nobody, either one blocked the other, or the only shared team switched messages off', async () => {
    const team = await newTeam([alice, bob, carol]);

    // 1. the recipient takes nobody
    expect(
      (await t.http.patch('/api/me').set(bob.auth).send({ allowDMsFrom: 'nobody' })).body
        .allowDMsFrom,
    ).toBe('nobody');
    const refused = await start(alice, bob);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject(refusal);
    expect((await start(bob, alice)).status).toBe(201); // a person who takes nobody can still write to others
    await t.http.patch('/api/me').set(bob.auth).send({ allowDMsFrom: 'members' });

    // 2. a block, in either direction
    expect((await t.http.put(`/api/blocks/${carol.id}`).set(alice.auth)).status).toBe(204);
    const byBlocker = await start(alice, carol);
    const byBlocked = await start(carol, alice);
    expect([byBlocker.status, byBlocked.status]).toEqual([403, 403]);
    expect(byBlocker.body).toEqual(byBlocked.body);
    expect(byBlocker.body).toMatchObject(refusal);
    await t.http.delete(`/api/blocks/${carol.id}`).set(alice.auth);
    expect((await start(alice, carol)).status).toBe(201);

    // 3. the team that connects them says no
    const dave = await signup(t);
    const erin = await signup(t);
    const other = await newTeam([dave, erin], 'Other');
    expect(
      (await t.http.patch(`/api/teams/${other.id}`).set(owner.auth).send({ allowMemberDMs: false }))
        .body.allowMemberDMs,
    ).toBe(false);
    const closedTeam = await start(dave, erin);
    expect(closedTeam.status).toBe(403);
    expect(closedTeam.body).toMatchObject(refusal);
    // but one team that allows it is enough
    await t.prisma.teamMember.create({ data: { teamId: team.id, userId: dave.id } });
    await t.prisma.teamMember.create({ data: { teamId: team.id, userId: erin.id } });
    expect((await start(dave, erin)).status).toBe(201);
  });

  it('only a team manager can switch messages between members off', async () => {
    const team = await newTeam();
    expect(
      (await t.http.patch(`/api/teams/${team.id}`).set(alice.auth).send({ allowMemberDMs: false }))
        .status,
    ).toBe(403);
    expect(
      (await t.http.patch(`/api/teams/${team.id}`).set(owner.auth).send({ allowMemberDMs: false }))
        .status,
    ).toBe(200);
    expect((await t.http.get(`/api/teams/${team.id}`).set(alice.auth)).body.allowMemberDMs).toBe(
      false,
    );
  });
});

// ------------------------------------------------------------------ who can read

describe('privacy', () => {
  it('answers 404 to everybody but the two people: other members, owners, administrators', async () => {
    await newTeam([alice, bob, carol]);
    const dm = await startOk(alice, bob);
    const message = await sendOk(alice, dm.channelId, 'secret');
    const file = await png();
    const up = await upload(alice, dm.channelId, file);
    expect(up.status, JSON.stringify(up.body)).toBe(201);

    for (const stranger of [carol, owner, admin, loner]) {
      expect(
        (await t.http.get(`/api/dms/${dm.id}`).set(stranger.auth)).status,
        'conversation',
      ).toBe(404);
      expect(
        (await t.http.post(`/api/dms/${dm.id}/close`).set(stranger.auth)).status,
        'close',
      ).toBe(404);
      expect(
        (await t.http.get(`/api/channels/${dm.channelId}`).set(stranger.auth)).status,
        'channel',
      ).toBe(404);
      expect((await list(stranger)).body).toEqual([]);
      expect(
        (await t.http.get(`/api/channels/${dm.channelId}/messages`).set(stranger.auth)).status,
        'list',
      ).toBe(404);
      expect((await send(stranger, dm.channelId)).status, 'send').toBe(404);
      expect(
        (await t.http.get(`/api/channels/${dm.channelId}/pins`).set(stranger.auth)).status,
        'pins',
      ).toBe(404);
      expect(
        (
          await t.http
            .get(`/api/channels/${dm.channelId}/search`)
            .set(stranger.auth)
            .query({ q: 'secret' })
        ).status,
        'search',
      ).toBe(404);
      expect((await upload(stranger, dm.channelId, file)).status, 'upload').toBe(404);
      expect(
        (
          await t.http
            .put(`/api/channels/${dm.channelId}/read`)
            .set(stranger.auth)
            .send({ messageId: message.id })
        ).status,
        'read',
      ).toBe(404);
      expect(
        (
          await t.http
            .put(`/api/messages/${message.id}/reactions/${encodeURIComponent('👍')}`)
            .set(stranger.auth)
        ).status,
        'react',
      ).toBe(404);
      expect(
        (
          await t.http
            .patch(`/api/messages/${message.id}`)
            .set(stranger.auth)
            .send({ content: 'x' })
        ).status,
        'edit',
      ).toBe(404);
      expect(
        (await t.http.delete(`/api/messages/${message.id}`).set(stranger.auth)).status,
        'delete',
      ).toBe(404);
      expect(
        (await t.http.put(`/api/messages/${message.id}/pin`).set(stranger.auth)).status,
        'pin',
      ).toBe(404);
      expect(
        (
          await t.http
            .post(`/api/messages/${message.id}/thread`)
            .set(stranger.auth)
            .send({ name: 'x' })
        ).status,
        'thread',
      ).toBe(404);
      const token = (await t.http.post('/api/auth/media-token').set(stranger.auth)).body
        .token as string;
      expect(
        (await t.http.get(`/api/media/${up.body.mediaId}`).query({ t: token })).status,
        'file',
      ).toBe(404);
    }

    // the two people see everything
    expect(
      (await t.http.get(`/api/channels/${dm.channelId}/messages`).set(bob.auth)).body.items,
    ).toHaveLength(1);
    const token = (await t.http.post('/api/auth/media-token').set(bob.auth)).body.token as string;
    expect((await t.http.get(`/api/media/${up.body.mediaId}`).query({ t: token })).status).toBe(
      200,
    );
    // a direct message is not a team channel: it has no channel endpoints of its own, and no threads
    expect(
      (await t.http.patch(`/api/channels/${dm.channelId}`).set(alice.auth).send({ name: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (await t.http.post(`/api/messages/${message.id}/thread`).set(alice.auth).send({ name: 'x' }))
        .status,
    ).toBe(404);
    // and team lists never contain it
    const team = await t.prisma.team.findFirstOrThrow();
    expect((await t.http.get(`/api/teams/${team.id}/channels`).set(alice.auth)).body).toEqual([]);
  });

  it('is never reachable through the realtime rooms of other people', async () => {
    await newTeam([alice, bob, carol]);
    const dm = await startOk(alice, bob);
    const seen = await connect(url, carol);
    expect((await ack(seen, 'room:join', { kind: 'channel', id: dm.channelId })).ok).toBe(false);
    const adminSocket = await connect(url, admin);
    expect((await ack(adminSocket, 'room:join', { kind: 'channel', id: dm.channelId })).ok).toBe(
      false,
    );
    const inside = await connect(url, bob);
    expect((await ack(inside, 'room:join', { kind: 'channel', id: dm.channelId })).ok).toBe(true);
  });

  it('lets either person do the things people do in a conversation, and nothing a moderator does', async () => {
    await newTeam();
    const dm = await startOk(alice, bob);
    const message = await sendOk(alice, dm.channelId, 'first');
    // reactions, replies, pins by either, edit by the author only, delete by the author only
    expect(
      (
        await t.http
          .put(`/api/messages/${message.id}/reactions/${encodeURIComponent('👍')}`)
          .set(bob.auth)
      ).status,
    ).toBe(204);
    const reply = await sendOk(bob, dm.channelId, 'reply', { replyToId: message.id });
    expect(reply.replyTo?.id).toBe(message.id);
    expect((await t.http.put(`/api/messages/${message.id}/pin`).set(bob.auth)).status).toBe(200);
    expect(
      (await t.http.get(`/api/channels/${dm.channelId}/pins`).set(alice.auth)).body,
    ).toHaveLength(1);
    expect(
      (
        await t.http
          .patch(`/api/messages/${message.id}`)
          .set(bob.auth)
          .send({ content: 'mine now' })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.http
          .patch(`/api/messages/${message.id}`)
          .set(alice.auth)
          .send({ content: 'edited' })
      ).status,
    ).toBe(200);
    expect((await t.http.delete(`/api/messages/${message.id}`).set(bob.auth)).status).toBe(403);
    expect((await t.http.delete(`/api/messages/${message.id}`).set(alice.auth)).status).toBe(204);
    const page = (await t.http.get(`/api/channels/${dm.channelId}/messages`).set(bob.auth))
      .body as MessagePageDto;
    expect(page.items.map((m) => [m.content, m.authorName])).toEqual([
      ['', 'Test'],
      ['reply', 'Test'],
    ]);
    expect(page.items[1]!.replyTo?.deleted).toBe(true);
  });
});

// ------------------------------------------------------------------ the rules at every send

describe('sending', () => {
  it('is checked again at every send: a block, switching off, and the end of the last shared team', async () => {
    const team = await newTeam([alice, bob]);
    const dm = await startOk(alice, bob);
    await sendOk(alice, dm.channelId, 'one');

    // the other person blocks: nothing more goes either way, and the message tells nothing
    await t.http.put(`/api/blocks/${alice.id}`).set(bob.auth);
    for (const who of [alice, bob]) {
      const res = await send(who, dm.channelId, 'two');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject(refusal);
    }
    // history still reads
    expect(
      (await t.http.get(`/api/channels/${dm.channelId}/messages`).set(alice.auth)).body.items,
    ).toHaveLength(1);
    await t.http.delete(`/api/blocks/${alice.id}`).set(bob.auth);
    await sendOk(alice, dm.channelId, 'three');

    // the recipient takes nobody
    await t.http.patch('/api/me').set(bob.auth).send({ allowDMsFrom: 'nobody' });
    expect((await send(alice, dm.channelId)).body).toMatchObject(refusal);
    await t.http.patch('/api/me').set(bob.auth).send({ allowDMsFrom: 'members' });

    // the last team they share is gone
    await t.prisma.teamMember.delete({
      where: { teamId_userId: { teamId: team.id, userId: bob.id } },
    });
    expect((await send(alice, dm.channelId)).body).toMatchObject(refusal);
    expect((await send(bob, dm.channelId)).body).toMatchObject(refusal);
    const history = (await t.http.get(`/api/channels/${dm.channelId}/messages`).set(bob.auth))
      .body as MessagePageDto;
    expect(history.items.map((m) => m.content)).toEqual(['one', 'three']);
    // nor can they add to it in other ways
    expect((await upload(alice, dm.channelId, await png())).status).toBe(403);
    expect(
      (
        await t.http
          .put(`/api/messages/${history.items[0]!.id}/reactions/${encodeURIComponent('👍')}`)
          .set(bob.auth)
      ).status,
    ).toBe(403);
    // and removing something they said is still possible
    expect(
      (await t.http.delete(`/api/messages/${history.items[0]!.id}`).set(alice.auth)).status,
    ).toBe(204);
  });

  it('a message that was already stored is not refused when it is sent again', async () => {
    await newTeam();
    const dm = await startOk(alice, bob);
    const id = uuidv7();
    expect(
      (
        await t.http
          .post(`/api/channels/${dm.channelId}/messages`)
          .set(alice.auth)
          .send({ id, content: 'once' })
      ).status,
    ).toBe(201);
    await t.http.put(`/api/blocks/${alice.id}`).set(bob.auth);
    expect(
      (
        await t.http
          .post(`/api/channels/${dm.channelId}/messages`)
          .set(alice.auth)
          .send({ id, content: 'once' })
      ).status,
    ).toBe(200);
  });
});

// ------------------------------------------------------------------ the list

describe('the list', () => {
  it('orders by the last message, counts unread, hides closed conversations and brings them back', async () => {
    await newTeam([alice, bob, carol]);
    const withBob = await startOk(alice, bob);
    const withCarol = await startOk(alice, carol);
    await sendOk(bob, withBob.channelId, 'hi alice');
    await sendOk(bob, withBob.channelId, 'are you there?');
    await sleep(5);
    await sendOk(carol, withCarol.channelId, 'hello from carol');

    let rows = (await list(alice)).body as DmDto[];
    expect(rows.map((r) => r.id)).toEqual([withCarol.id, withBob.id]);
    expect(rows.map((r) => r.unread)).toEqual([1, 2]);
    expect(rows[1]!.lastMessage).toMatchObject({
      snippet: 'are you there?',
      authorId: bob.id,
      deleted: false,
    });
    expect(rows[1]!.peer?.id).toBe(bob.id);
    // bob wrote, so for bob his own messages are not unread
    expect(((await list(bob)).body as DmDto[])[0]!.unread).toBe(0);

    // reading clears it
    const last = (
      await t.http.get(`/api/channels/${withBob.channelId}/messages`).set(alice.auth)
    ).body.items.at(-1) as MessageDto;
    await t.http
      .put(`/api/channels/${withBob.channelId}/read`)
      .set(alice.auth)
      .send({ messageId: last.id });
    rows = (await list(alice)).body;
    expect(rows.find((r) => r.id === withBob.id)!.unread).toBe(0);

    // closing hides it for alice only
    const closed = await t.http.post(`/api/dms/${withBob.id}/close`).set(alice.auth);
    expect(closed.body.closed).toBe(true);
    expect(((await list(alice)).body as DmDto[]).map((r) => r.id)).toEqual([withCarol.id]);
    expect(((await list(bob)).body as DmDto[]).map((r) => r.id)).toEqual([withBob.id]);
    expect(
      (await t.http.get('/api/dms').query({ closed: 'true' }).set(alice.auth)).body as DmDto[],
    ).toHaveLength(2);
    // history is untouched
    expect(
      (await t.http.get(`/api/channels/${withBob.channelId}/messages`).set(alice.auth)).body.items,
    ).toHaveLength(2);

    // a new message from the other side opens it again, unread
    await sendOk(bob, withBob.channelId, 'back again');
    rows = (await list(alice)).body;
    expect(rows[0]).toMatchObject({ id: withBob.id, closed: false, unread: 1 });
    // starting it again also shows it
    await t.http.post(`/api/dms/${withBob.id}/close`).set(alice.auth);
    expect((await startOk(alice, bob)).closed).toBe(false);
    expect((await t.http.post(`/api/dms/${withBob.id}/open`).set(alice.auth)).body.closed).toBe(
      false,
    );
  });

  it('tells the two people when it changes, and nobody else', async () => {
    await newTeam([alice, bob, carol]);
    const mine = await connect(url, alice);
    const theirs = await connect(url, bob);
    const other = await connect(url, carol);
    const forAlice = collect<{ conversationId: string }>(mine, 'dm.updated');
    const forBob = collect<{ conversationId: string }>(theirs, 'dm.updated');
    const forCarol = collect(other, 'dm.updated');
    const dm = await startOk(alice, bob);
    await sleep(150);
    expect(forAlice).toHaveLength(1);
    expect(forBob).toHaveLength(0); // being written to is what tells bob
    await sendOk(alice, dm.channelId, 'ping');
    await sleep(150);
    expect(forBob.map((e) => e.conversationId)).toEqual([dm.id]);
    expect(forAlice.length).toBeGreaterThanOrEqual(2);
    expect(forCarol).toHaveLength(0);
  });

  it('lists the people from your teams who can be messaged, and nobody else', async () => {
    const team = await newTeam([alice, bob, carol]);
    const rows = (await t.http.get('/api/dms/people').set(alice.auth)).body as {
      userId: string;
      teams: string[];
    }[];
    expect(rows.map((r) => r.userId).sort()).toEqual([bob.id, carol.id, owner.id].sort());
    expect(rows[0]!.teams).toEqual(['Chatters']);
    expect((await t.http.get('/api/dms/people').set(loner.auth)).body).toEqual([]);
    // a team that switched messages off does not make people findable
    await t.http.patch(`/api/teams/${team.id}`).set(owner.auth).send({ allowMemberDMs: false });
    expect((await t.http.get('/api/dms/people').set(alice.auth)).body).toEqual([]);
    await t.http.patch(`/api/teams/${team.id}`).set(owner.auth).send({ allowMemberDMs: true });
    // somebody you blocked is not offered
    await t.http.put(`/api/blocks/${bob.id}`).set(alice.auth);
    expect(
      ((await t.http.get('/api/dms/people').set(alice.auth)).body as { userId: string }[]).map(
        (r) => r.userId,
      ),
    ).not.toContain(bob.id);
  });

  it('keeps a conversation readable by the other person when an account is gone', async () => {
    await newTeam();
    const dm = await startOk(alice, bob);
    await sendOk(bob, dm.channelId, 'goodbye');
    await t.prisma.user.delete({ where: { id: bob.id } });
    const rows = (await list(alice)).body as DmDto[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.peer).toBeNull();
    const page = (await t.http.get(`/api/channels/${dm.channelId}/messages`).set(alice.auth))
      .body as MessagePageDto;
    expect(page.items[0]).toMatchObject({ content: 'goodbye', authorId: null, authorName: null });
    expect((await send(alice, dm.channelId)).body).toMatchObject(refusal);

    // when the second account goes too, the maintenance job removes the conversation
    await t.prisma.user.delete({ where: { id: alice.id } });
    expect(await t.app.get(ChatMaintenance).collectDeadConversations()).toBe(1);
    expect(await t.prisma.channel.count({ where: { kind: 'dm' } })).toBe(0);
    expect(await t.prisma.message.count({ where: { channelId: dm.channelId } })).toBe(0);
  });
});

// ------------------------------------------------------------------ blocks

describe('blocks', () => {
  it('are listed, can be removed, and never shown to the person who was blocked', async () => {
    await newTeam();
    const dm = await startOk(alice, bob);
    expect((await t.http.put(`/api/blocks/${bob.id}`).set(alice.auth)).status).toBe(204);
    expect((await t.http.put(`/api/blocks/${bob.id}`).set(alice.auth)).status).toBe(204); // twice changes nothing
    expect((await t.http.get('/api/blocks').set(alice.auth)).body).toMatchObject([
      { userId: bob.id, displayName: 'Test' },
    ]);
    expect((await t.http.get('/api/blocks').set(bob.auth)).body).toEqual([]);
    expect(((await list(alice)).body as DmDto[])[0]!.blocked).toBe(true);
    expect(((await list(bob)).body as DmDto[])[0]!.blocked).toBe(false);
    expect(await t.prisma.directConversation.count()).toBe(1);
    expect((await t.http.put(`/api/blocks/${alice.id}`).set(alice.auth)).status).toBe(422);
    expect((await t.http.put(`/api/blocks/${uuid()}`).set(alice.auth)).status).toBe(404);
    expect((await t.http.delete(`/api/blocks/${bob.id}`).set(alice.auth)).status).toBe(204);
    expect((await t.http.get('/api/blocks').set(alice.auth)).body).toEqual([]);
    expect(dm.id).toBeTruthy();
  });
});

// ------------------------------------------------------------------ quota

describe('quota', () => {
  it('charges attachments and text to the sender, refunds on delete, and refuses what does not fit', async () => {
    const team = await newTeam();
    const dm = await startOk(alice, bob);
    const file = await png(60, 60);
    const teamSpace = (await t.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).spaceId;
    const aliceBefore = await storageOf(alice.id);

    const up = await upload(alice, dm.channelId, file);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const msg = await sendOk(alice, dm.channelId, 'look', { attachmentIds: [up.body.id] });
    expect(await storageOf(alice.id)).toBe(aliceBefore + file.length + Buffer.byteLength('look'));
    expect(await storageOf(bob.id)).toBe(0);
    expect(
      Number(
        (await t.prisma.space.findUniqueOrThrow({ where: { id: teamSpace } })).storageUsedBytes,
      ),
    ).toBe(0);
    expect(
      (await t.prisma.media.findUniqueOrThrow({ where: { id: up.body.mediaId } })).spaceId,
    ).toBe(await personalSpaceId(t, alice.id));
    // the text counts as documents in the sender's breakdown
    expect(
      (await t.http.get('/api/me/storage').set(alice.auth)).body.documents,
    ).toBeGreaterThanOrEqual(Buffer.byteLength('look'));

    // the other person's reply is charged to them
    await sendOk(bob, dm.channelId, 'thanks');
    expect(await storageOf(bob.id)).toBe(Buffer.byteLength('thanks'));

    expect((await t.http.delete(`/api/messages/${msg.id}`).set(alice.auth)).status).toBe(204);
    expect(await storageOf(alice.id)).toBe(aliceBefore);

    // over the limit: nothing is stored
    await t.prisma.quotaOverride.create({
      data: {
        id: uuid(),
        scope: 'user',
        scopeId: alice.id,
        storageBytes: BigInt(file.length + 10),
        updatedBy: admin.id,
      },
    });
    expect((await upload(alice, dm.channelId, file)).status).toBe(201);
    const second = await upload(alice, dm.channelId, await png(61, 61));
    expect(second.status).toBe(413);
    expect(second.body).toMatchObject({ code: 'quota_exceeded', scope: 'user' });
    expect((await send(alice, dm.channelId, 'x'.repeat(11))).status).toBe(413);
    expect(
      await t.prisma.message.count({
        where: { channelId: dm.channelId, authorId: alice.id, deletedAt: null },
      }),
    ).toBe(0);
  });
});

// ------------------------------------------------------------------ settings

describe('settings', () => {
  it('lets a person choose who may message them', async () => {
    expect((await t.http.get('/api/me').set(alice.auth)).body.allowDMsFrom).toBe('members');
    expect(
      (await t.http.patch('/api/me').set(alice.auth).send({ allowDMsFrom: 'everyone' })).status,
    ).toBe(400);
    expect(
      (await t.http.patch('/api/me').set(alice.auth).send({ allowDMsFrom: 'nobody' })).body
        .allowDMsFrom,
    ).toBe('nobody');
  });

  it('is not affected by roles: a moderator of a team still cannot read a conversation', async () => {
    const team = await newTeam([alice, bob, carol]);
    const res = await t.http
      .post(`/api/teams/${team.id}/roles`)
      .set(owner.auth)
      .send({
        name: 'all',
        permissions: permissionsToString(Object.values(Permission).reduce((a, b) => a | b, 0n)),
      });
    await t.http
      .put(`/api/teams/${team.id}/members/${carol.id}/roles/${res.body.id}`)
      .set(owner.auth);
    const dm = await startOk(alice, bob);
    await sendOk(alice, dm.channelId, 'private');
    expect(
      (await t.http.get(`/api/channels/${dm.channelId}/messages`).set(carol.auth)).status,
    ).toBe(404);
    // nor does it show in the audit log
    const audit = await t.http.get(`/api/teams/${team.id}/audit`).set(owner.auth);
    expect(JSON.stringify(audit.body)).not.toContain('private');
  });
});
