import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, decodeJwt, jwtVerify } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Permission,
  permissionsToString,
  type ChannelDto,
  type VoiceChannelStateDto,
  type VoiceModeratedEvent,
  type VoiceTokenDto,
} from '@os-planner/shared';
import { VoiceService } from '../src/voice/voice.service.js';
import { createTestApp, type TestApp } from './app.js';
import { signup, type Account } from './helpers.js';
import { ack, closeSockets, collect, connect, listen, sleep } from './sockets.js';

const P = Permission;
const KEY = 'APItestkey';
const SECRET = 'a-livekit-secret-that-is-32-chars-or-more!';
const ADMIN_EMAIL = `voice-admin${Date.now()}@example.com`;
/** What a person needs to talk, show the camera and share the screen. */
const VOICE_ALL = P.CONNECT | P.SPEAK | P.VIDEO | P.SCREEN_SHARE;

// ------------------------------------------------------------------ a stand-in for the media server

interface Call {
  method: string;
  body: Record<string, any>;
}

/** The part of LiveKit's room API the server uses, answering like the real one (and remembering what it was asked). */
class FakeLiveKit {
  calls: Call[] = [];
  rooms = new Map<
    string,
    {
      sid: string;
      identity: string;
      tracks: { sid: string; type: string; source: string; muted: boolean }[];
    }[]
  >();
  down = false;
  private server: Server;
  url = '';

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  private async handle(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
    const method = (req.url ?? '').split('/').pop() ?? '';
    try {
      const { payload } = await jwtVerify(
        (req.headers.authorization ?? '').replace('Bearer ', ''),
        new TextEncoder().encode(SECRET),
        {
          issuer: KEY,
        },
      );
      if (!(payload['video'] as { roomAdmin?: boolean } | undefined)?.roomAdmin)
        throw new Error('not an admin token');
    } catch {
      res.writeHead(401).end('{}');
      return;
    }
    if (this.down) {
      res.writeHead(503).end('{}');
      return;
    }
    this.calls.push({ method, body });
    const room = this.rooms.get(body.room as string) ?? [];
    let answer: unknown = {};
    if (method === 'RemoveParticipant') {
      if (!room.some((p) => p.identity === body.identity)) return void res.writeHead(404).end('{}');
      this.rooms.set(
        body.room,
        room.filter((p) => p.identity !== body.identity),
      );
    } else if (method === 'ListParticipants') answer = { participants: room };
    else if (method === 'ListRooms')
      answer = { rooms: [...this.rooms.keys()].map((name) => ({ name })) };
    else if (method === 'DeleteRoom') this.rooms.delete(body.room);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
  }
}

/** A webhook as LiveKit sends it: the JSON body and a JWT (signed with the secret) that carries the body's hash. */
async function hook(
  t: TestApp,
  event: Record<string, unknown>,
  opts: { secret?: string; tamper?: boolean } = {},
) {
  const body = JSON.stringify({
    id: `EV_${Math.random().toString(36).slice(2)}`,
    createdAt: Math.floor(Date.now() / 1000),
    ...event,
  });
  const jwt = await new SignJWT({ sha256: createHash('sha256').update(body).digest('base64') })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(KEY)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));
  return t.http
    .post('/api/voice/webhook')
    .set('Authorization', jwt)
    .set('Content-Type', 'application/webhook+json')
    .send(opts.tamper ? `${body} ` : body);
}

// ------------------------------------------------------------------ setup

let lk: FakeLiveKit;
let t: TestApp;
let url: string;
let saved: Record<string, string | undefined> = {};
let admin: Account;
let owner: Account;
let a: Account;
let b: Account;
let c: Account;
let outsider: Account;
let teamId: string;
let spaceId: string;

const SETTINGS = (): Record<string, string> => ({
  ADMIN_EMAILS: ADMIN_EMAIL,
  LIVEKIT_URL: 'wss://voice.example.test',
  LIVEKIT_API_URL: lk.url,
  LIVEKIT_API_KEY: KEY,
  LIVEKIT_API_SECRET: SECRET,
  VOICE_CHECK_SECONDS: '0',
});

beforeAll(async () => {
  lk = new FakeLiveKit();
  await lk.start();
  for (const [k, v] of Object.entries(SETTINGS())) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t = await createTestApp();
  url = await listen(t);
});
afterAll(async () => {
  closeSockets();
  await t.close();
  await lk.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  lk.calls = [];
  lk.rooms.clear();
  lk.down = false;
  await t.prisma.team.deleteMany();
  await t.prisma.quotaOverride.deleteMany();
  await t.prisma.user.deleteMany();
  admin = await signup(t, true, ADMIN_EMAIL);
  owner = await signup(t);
  a = await signup(t);
  b = await signup(t);
  c = await signup(t);
  outsider = await signup(t);
  const res = await t.http
    .post('/api/admin/teams')
    .set(admin.auth)
    .send({ name: 'Talkers', ownerEmail: owner.email });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  teamId = res.body.id;
  for (const m of [a, b, c]) await t.prisma.teamMember.create({ data: { teamId, userId: m.id } });
  spaceId = (await t.prisma.team.findUniqueOrThrow({ where: { id: teamId } })).spaceId;
});
afterEach(() => closeSockets());

// ------------------------------------------------------------------ helpers

const everyone = () => t.prisma.role.findFirstOrThrow({ where: { teamId, isEveryone: true } });
async function grantEveryone(bits: bigint): Promise<void> {
  const role = await everyone();
  const res = await t.http
    .patch(`/api/roles/${role.id}`)
    .set(owner.auth)
    .send({ permissions: permissionsToString(role.permissions | bits) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
const voiceChannel = async (body: object = {}, who = owner): Promise<ChannelDto> => {
  const res = await t.http
    .post(`/api/spaces/${spaceId}/channels`)
    .set(who.auth)
    .send({ name: 'Lounge', kind: 'voice', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as ChannelDto;
};
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
const tokenOf = (who: Account, channelId: string) =>
  t.http.post(`/api/channels/${channelId}/voice/token`).set(who.auth);
const joinHook = (
  who: Account,
  channelId: string,
  sid = `PA_${who.id.slice(0, 6)}`,
  extra: object = {},
) =>
  hook(t, {
    event: 'participant_joined',
    room: { name: channelId },
    participant: { sid, identity: who.id, joinedAt: Math.floor(Date.now() / 1000) },
    ...extra,
  });
const leftHook = (who: Account, channelId: string, sid = `PA_${who.id.slice(0, 6)}`) =>
  hook(t, {
    event: 'participant_left',
    room: { name: channelId },
    participant: { sid, identity: who.id },
  });
/** The person is in the room, as far as the media server and the webhook are concerned. */
async function inRoom(
  who: Account,
  channelId: string,
  sid = `PA_${who.id.slice(0, 6)}`,
): Promise<void> {
  lk.rooms.set(channelId, [
    ...(lk.rooms.get(channelId) ?? []),
    {
      sid,
      identity: who.id,
      tracks: [
        { sid: `TR_${who.id.slice(0, 4)}`, type: 'AUDIO', source: 'MICROPHONE', muted: false },
      ],
    },
  ]);
  expect((await joinHook(who, channelId, sid)).status).toBe(200);
}
const rows = (channelId: string) => t.prisma.voiceParticipant.findMany({ where: { channelId } });
const audit = (action: string) => t.prisma.auditLog.findMany({ where: { teamId, action } });

// ------------------------------------------------------------------ tests

describe('features and channels', () => {
  it('reports voice on, and lets a channel manager make voice channels with a limit and a quality', async () => {
    const f = await t.http.get('/api/features');
    expect(f.status).toBe(200);
    expect(f.body).toMatchObject({ voice: true });

    const ch = await voiceChannel({ userLimit: 4, quality: 'high' });
    expect(ch).toMatchObject({ kind: 'voice', userLimit: 4, quality: 'high' });
    const patched = await t.http
      .patch(`/api/channels/${ch.id}`)
      .set(owner.auth)
      .send({ userLimit: null, quality: 'low' });
    expect(patched.body).toMatchObject({ userLimit: null, quality: 'low' });

    // a text channel has neither; a member cannot make channels
    const text = await t.http
      .post(`/api/spaces/${spaceId}/channels`)
      .set(owner.auth)
      .send({ name: 'chat', userLimit: 3 });
    expect(text.status).toBe(422);
    expect(
      (
        await t.http
          .post(`/api/spaces/${spaceId}/channels`)
          .set(a.auth)
          .send({ name: 'v', kind: 'voice' })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.http
          .post(`/api/spaces/${spaceId}/channels`)
          .set(owner.auth)
          .send({ name: 'v', kind: 'voice', userLimit: 0 })
      ).status,
    ).toBe(400);
  });
});

describe('the token', () => {
  it('answers 404 without VIEW_CHANNEL, 404 for text channels, 403 without CONNECT', async () => {
    const ch = await voiceChannel();
    expect((await tokenOf(outsider, ch.id)).status).toBe(404); // not in the team
    const text = await t.http
      .post(`/api/spaces/${spaceId}/channels`)
      .set(owner.auth)
      .send({ name: 'chat' });
    expect((await tokenOf(a, text.body.id)).status).toBe(404);
    expect((await tokenOf(a, ch.id)).status).toBe(403); // can see it, cannot connect
    expect((await overwrite(owner, ch.id, a, 0n, P.VIEW_CHANNEL)).status).toBe(200);
    expect((await tokenOf(a, ch.id)).status).toBe(404); // hidden: looks like it does not exist
    expect((await tokenOf(owner, ch.id)).status).toBe(200);
  });

  it('puts exactly the permissions of the person in the grants, and lives 10 minutes', async () => {
    const ch = await voiceChannel({ quality: 'high' });
    const cases: [bigint, string[]][] = [
      [P.CONNECT, []],
      [P.CONNECT | P.SPEAK, ['microphone']],
      [P.CONNECT | P.VIDEO, ['camera']],
      [P.CONNECT | P.SCREEN_SHARE, ['screen_share', 'screen_share_audio']],
      [VOICE_ALL, ['microphone', 'camera', 'screen_share', 'screen_share_audio']],
    ];
    for (const [bits, sources] of cases) {
      expect((await overwrite(owner, ch.id, a, bits, 0n)).status).toBe(200);
      const res = await tokenOf(a, ch.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const body = res.body as VoiceTokenDto;
      const claims = decodeJwt(body.token) as Record<string, any>;
      expect(claims.iss).toBe(KEY);
      expect(claims.sub).toBe(a.id);
      expect(claims.video).toMatchObject({
        room: ch.id,
        roomJoin: true,
        canSubscribe: true,
        canPublish: sources.length > 0,
        canPublishSources: sources,
      });
      expect(claims.exp - claims.nbf).toBeGreaterThanOrEqual(600);
      expect(claims.exp - claims.nbf).toBeLessThanOrEqual(610);
      expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(590_000);
      expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(600_000);
      expect(body).toMatchObject({
        url: 'wss://voice.example.test',
        canSpeak: sources.includes('microphone'),
        bitrate: 96000,
      });
      await jwtVerify(body.token, new TextEncoder().encode(SECRET)); // really signed with the secret
    }
  });

  it('answers 409 when the channel or the team is full', async () => {
    await grantEveryone(VOICE_ALL);
    const ch = await voiceChannel({ userLimit: 1 });
    expect((await tokenOf(a, ch.id)).status).toBe(200);
    await inRoom(a, ch.id);
    expect((await tokenOf(b, ch.id)).body).toMatchObject({ message: 'channel_full' });
    expect((await tokenOf(b, ch.id)).status).toBe(409);
    expect((await tokenOf(a, ch.id)).status).toBe(200); // somebody already in may ask again (a reconnect)

    const other = await voiceChannel({ name: 'Other' });
    expect((await tokenOf(b, other.id)).status).toBe(200);
    const set = await t.http
      .put(`/api/admin/quotas/team/${teamId}`)
      .set(admin.auth)
      .send({ maxVoiceParticipants: 1 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await tokenOf(b, other.id)).body).toMatchObject({ message: 'team_voice_full' });
  });
});

describe('the webhook', () => {
  it('refuses what is not signed by the media server', async () => {
    const ch = await voiceChannel();
    expect(
      (
        await hook(
          t,
          {
            event: 'participant_joined',
            room: { name: ch.id },
            participant: { sid: 'x', identity: a.id },
          },
          { secret: `${SECRET}-other` },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await hook(
          t,
          {
            event: 'participant_joined',
            room: { name: ch.id },
            participant: { sid: 'x', identity: a.id },
          },
          { tamper: true },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await t.http
          .post('/api/voice/webhook')
          .set('Content-Type', 'application/webhook+json')
          .send('{}')
      ).status,
    ).toBe(401);
    expect(
      (
        await t.http
          .post('/api/voice/webhook')
          .set('Authorization', 'garbage')
          .set('Content-Type', 'application/webhook+json')
          .send('{}')
      ).status,
    ).toBe(401);
    expect(await rows(ch.id)).toHaveLength(0);
  });

  it('keeps who is in the channel, tells the room, and is idempotent', async () => {
    await grantEveryone(VOICE_ALL);
    const ch = await voiceChannel();
    const sock = await connect(url, b);
    expect(await ack(sock, 'room:join', { kind: 'channel', id: ch.id })).toEqual({ ok: true });
    const heard = collect<VoiceChannelStateDto>(sock, 'voice.participants');

    await inRoom(a, ch.id);
    await sleep(150);
    expect(heard.at(-1)?.participants.map((p) => p.userId)).toEqual([a.id]);
    expect((await joinHook(a, ch.id)).status).toBe(200); // the same event again
    expect(
      (
        await hook(t, {
          id: 'EV_same',
          event: 'participant_joined',
          room: { name: ch.id },
          participant: { sid: `PA_${a.id.slice(0, 6)}`, identity: a.id },
        })
      ).status,
    ).toBe(200);
    expect(await rows(ch.id)).toHaveLength(1);

    await inRoom(c, ch.id);
    await sleep(150);
    expect(
      heard
        .at(-1)
        ?.participants.map((p) => p.userId)
        .sort(),
    ).toEqual([a.id, c.id].sort());
    expect((await t.http.get(`/api/teams/${teamId}/voice`).set(b.auth)).body).toEqual([
      expect.objectContaining({ channelId: ch.id }),
    ]);

    expect((await leftHook(a, ch.id)).status).toBe(200);
    expect((await leftHook(a, ch.id)).status).toBe(200);
    await sleep(150);
    expect(heard.at(-1)?.participants.map((p) => p.userId)).toEqual([c.id]);
  });

  it('copes with a reconnect that arrives out of order, and with events that come late', async () => {
    await grantEveryone(VOICE_ALL);
    const ch = await voiceChannel();
    await inRoom(a, ch.id, 'PA_old');
    // the new connection is announced before the old one is said to have left
    expect((await joinHook(a, ch.id, 'PA_new')).status).toBe(200);
    expect((await leftHook(a, ch.id, 'PA_old')).status).toBe(200);
    expect((await rows(ch.id)).map((r) => r.sid)).toEqual(['PA_new']);

    // "left" first, "joined" late: the person must not come back as a ghost
    expect((await leftHook(b, ch.id, 'PA_b1')).status).toBe(200);
    expect((await joinHook(b, ch.id, 'PA_b1')).status).toBe(200);
    expect((await rows(ch.id)).map((r) => r.userId)).toEqual([a.id]);

    // a replayed event from long ago is ignored
    const old = await hook(t, {
      event: 'participant_joined',
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      room: { name: ch.id },
      participant: { sid: 'PA_c', identity: c.id },
    });
    expect(old.status).toBe(200);
    expect((await rows(ch.id)).map((r) => r.userId)).toEqual([a.id]);

    expect((await hook(t, { event: 'room_finished', room: { name: ch.id } })).status).toBe(200);
    expect(await rows(ch.id)).toHaveLength(0);
  });

  it('removes somebody who joins without being allowed to, or beyond the limit', async () => {
    const ch = await voiceChannel({ userLimit: 1 });
    lk.rooms.set(ch.id, [{ sid: 'PA_x', identity: a.id, tracks: [] }]);
    expect((await joinHook(a, ch.id, 'PA_x')).status).toBe(200); // a has no CONNECT
    expect(await rows(ch.id)).toHaveLength(0);
    expect(lk.of('RemoveParticipant')).toEqual([
      { method: 'RemoveParticipant', body: { room: ch.id, identity: a.id } },
    ]);

    await grantEveryone(VOICE_ALL);
    await inRoom(a, ch.id, 'PA_a');
    lk.rooms.set(ch.id, [
      ...(lk.rooms.get(ch.id) ?? []),
      { sid: 'PA_b', identity: b.id, tracks: [] },
    ]);
    expect((await joinHook(b, ch.id, 'PA_b')).status).toBe(200); // the room is full
    expect((await rows(ch.id)).map((r) => r.userId)).toEqual([a.id]);
    expect(lk.of('RemoveParticipant').at(-1)?.body).toEqual({ room: ch.id, identity: b.id });
  });

  it('is checked against the media server: ghosts go, people the webhooks missed come in', async () => {
    await grantEveryone(VOICE_ALL);
    const ch = await voiceChannel();
    await inRoom(a, ch.id);
    lk.rooms.set(ch.id, [{ sid: 'PA_late', identity: b.id, tracks: [] }]); // a is gone without a word, b came without one
    await t.app.get(VoiceService).reconcile();
    expect((await rows(ch.id)).map((r) => r.userId)).toEqual([b.id]);
  });
});

describe('moderation', () => {
  it('needs MUTE_MEMBERS and respects the hierarchy; every action is audited', async () => {
    await grantEveryone(VOICE_ALL);
    const ch = await voiceChannel();
    const modRole = await t.http
      .post(`/api/teams/${teamId}/roles`)
      .set(owner.auth)
      .send({ name: 'Mods', permissions: permissionsToString(P.MUTE_MEMBERS | P.MOVE_MEMBERS) });
    expect(modRole.status).toBe(201);
    const topRole = await t.http
      .post(`/api/teams/${teamId}/roles`)
      .set(owner.auth)
      .send({ name: 'Top', permissions: permissionsToString(P.MUTE_MEMBERS) });
    expect(
      (
        await t.http
          .put(`/api/teams/${teamId}/members/${b.id}/roles/${modRole.body.id}`)
          .set(owner.auth)
      ).status,
    ).toBe(204);
    expect(
      (
        await t.http
          .put(`/api/teams/${teamId}/members/${c.id}/roles/${topRole.body.id}`)
          .set(owner.auth)
      ).status,
    ).toBe(204);
    // new roles start at the lowest position, so "Top" (made second) ranks below "Mods": b may moderate c
    await inRoom(a, ch.id);
    await inRoom(b, ch.id);
    await inRoom(c, ch.id);
    await inRoom(owner, ch.id);
    const mute = (who: Account, target: Account) =>
      t.http.post(`/api/channels/${ch.id}/voice/participants/${target.id}/mute`).set(who.auth);

    expect((await mute(a, c)).status).toBe(403); // a holds no MUTE_MEMBERS
    expect((await mute(b, owner)).status).toBe(403); // never the owner
    expect((await mute(b, b)).status).toBe(403); // nor yourself
    expect((await mute(b, outsider)).status).toBe(404); // not in the channel
    expect((await mute(outsider, a)).status).toBe(404); // cannot even see it
    expect((await mute(b, a)).status).toBe(204);

    expect(lk.of('UpdateParticipant').at(-1)?.body).toMatchObject({
      room: ch.id,
      identity: a.id,
      permission: { canPublishSources: ['CAMERA', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'] },
      attributes: { modMuted: '1' },
    });
    expect((await rows(ch.id)).find((r) => r.userId === a.id)?.mutedByModerator).toBe(true);
    // the muted person cannot get a token that lets them talk
    const token = await tokenOf(a, ch.id);
    expect(token.body).toMatchObject({ canSpeak: false, mutedByModerator: true });
    expect((decodeJwt(token.body.token) as any).video.canPublishSources).not.toContain(
      'microphone',
    );

    expect(
      (await t.http.post(`/api/channels/${ch.id}/voice/participants/${a.id}/unmute`).set(b.auth))
        .status,
    ).toBe(204);
    expect(lk.of('UpdateParticipant').at(-1)?.body.permission.canPublishSources).toContain(
      'MICROPHONE',
    );
    expect((await rows(ch.id)).find((r) => r.userId === a.id)?.mutedByModerator).toBe(false);

    expect((await audit('voice.mute')).map((e) => [e.actorId, e.targetId])).toEqual([[b.id, a.id]]);
    expect(await audit('voice.unmute')).toHaveLength(1);
    // the owner may moderate anybody
    expect((await mute(owner, b)).status).toBe(204);
    expect((await mute(b, c)).status).toBe(204); // c's highest role is below b's
    expect((await mute(c, b)).status).toBe(403); // c holds the permission too, but b outranks c
    expect((await mute(owner, c)).status).toBe(204);
  });

  it('moves and disconnects, with the destination checked', async () => {
    await grantEveryone(VOICE_ALL | P.MUTE_MEMBERS);
    const one = await voiceChannel({ name: 'One' });
    const two = await voiceChannel({ name: 'Two' });
    const full = await voiceChannel({ name: 'Full', userLimit: 1 });
    const text = await t.http
      .post(`/api/spaces/${spaceId}/channels`)
      .set(owner.auth)
      .send({ name: 'chat' });
    await inRoom(a, one.id);
    await inRoom(c, full.id);
    const sock = await connect(url, a);
    const told = collect<VoiceModeratedEvent>(sock, 'voice.moderated');
    const move = (to: string, who = owner) =>
      t.http
        .post(`/api/channels/${one.id}/voice/participants/${a.id}/move`)
        .set(who.auth)
        .send({ toChannelId: to });

    expect((await move(two.id, b)).status).toBe(403); // b may mute but not move
    expect((await move(text.body.id)).status).toBe(422);
    expect((await move(one.id)).status).toBe(422);
    expect((await move(full.id)).status).toBe(409);
    await overwrite(owner, two.id, a, 0n, P.CONNECT);
    expect((await move(two.id)).status).toBe(422); // a could not join there
    await t.http
      .delete(
        `/api/overwrites/${(await t.prisma.overwrite.findFirstOrThrow({ where: { targetId: two.id } })).id}`,
      )
      .set(owner.auth);
    expect((await move(two.id)).status).toBe(204);
    await sleep(150);
    expect(told.at(-1)).toMatchObject({
      action: 'move',
      channelId: one.id,
      toChannelId: two.id,
      byUserId: owner.id,
    });
    expect((await audit('voice.move'))[0]?.after).toMatchObject({
      channelId: one.id,
      toChannelId: two.id,
    });

    const kick = await t.http
      .post(`/api/channels/${one.id}/voice/participants/${a.id}/disconnect`)
      .set(owner.auth);
    expect(kick.status).toBe(204);
    expect(lk.of('RemoveParticipant').at(-1)?.body).toEqual({ room: one.id, identity: a.id });
    expect(await rows(one.id)).toHaveLength(0);
    expect(await audit('voice.disconnect')).toHaveLength(1);
    expect(
      (
        await t.http
          .post(`/api/channels/${one.id}/voice/participants/${a.id}/disconnect`)
          .set(owner.auth)
      ).status,
    ).toBe(404);
  });
});

describe('when permissions change', () => {
  it('removes somebody whose CONNECT is revoked, and a member who is removed, within moments', async () => {
    await grantEveryone(VOICE_ALL);
    const ch = await voiceChannel();
    await inRoom(a, ch.id);
    await inRoom(b, ch.id);
    const sock = await connect(url, a);
    const told = collect<VoiceModeratedEvent>(sock, 'voice.moderated');

    const started = Date.now();
    expect((await overwrite(owner, ch.id, a, 0n, P.CONNECT)).status).toBe(200);
    expect(lk.of('RemoveParticipant').map((x) => x.body)).toEqual([
      { room: ch.id, identity: a.id },
    ]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await rows(ch.id)).map((r) => r.userId)).toEqual([b.id]);
    await sleep(150);
    expect(told.at(-1)).toMatchObject({ action: 'disconnect', channelId: ch.id });

    expect(
      (await t.http.delete(`/api/teams/${teamId}/members/${b.id}`).set(owner.auth)).status,
    ).toBe(204);
    expect(lk.of('RemoveParticipant').map((x) => x.body)).toContainEqual({
      room: ch.id,
      identity: b.id,
    });
    expect(await rows(ch.id)).toHaveLength(0);
  });

  it('takes the microphone from somebody who loses SPEAK, and tries again when the media server is down', async () => {
    await grantEveryone(VOICE_ALL);
    const ch = await voiceChannel();
    await inRoom(a, ch.id);
    expect((await overwrite(owner, ch.id, a, 0n, P.SPEAK)).status).toBe(200);
    expect(lk.of('UpdateParticipant').at(-1)?.body).toMatchObject({
      identity: a.id,
      permission: { canPublishSources: ['CAMERA', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'] },
    });
    expect(lk.of('MutePublishedTrack').at(-1)?.body).toMatchObject({ identity: a.id, muted: true });
    expect(await rows(ch.id)).toHaveLength(1);

    lk.down = true;
    expect((await overwrite(owner, ch.id, a, 0n, P.CONNECT | P.SPEAK)).status).toBe(200);
    expect(await rows(ch.id)).toHaveLength(1); // not confirmed: stays until the server can be reached
    lk.down = false;
    await t.app.get(VoiceService).enforce();
    expect(await rows(ch.id)).toHaveLength(0);
  });

  it('closes the room when the channel is deleted or archived', async () => {
    await grantEveryone(VOICE_ALL);
    const ch = await voiceChannel();
    await inRoom(a, ch.id);
    expect(
      (await t.http.patch(`/api/channels/${ch.id}`).set(owner.auth).send({ archived: true }))
        .status,
    ).toBe(200);
    expect(lk.of('RemoveParticipant').map((x) => x.body)).toEqual([
      { room: ch.id, identity: a.id },
    ]);
    expect((await tokenOf(a, ch.id)).status).toBe(409);

    const other = await voiceChannel({ name: 'Gone' });
    expect((await t.http.delete(`/api/channels/${other.id}`).set(owner.auth)).status).toBe(204);
    await sleep(150);
    expect(lk.of('DeleteRoom').map((x) => x.body)).toEqual([{ room: other.id }]);
  });
});

describe('who sees what', () => {
  it('lists only the voice channels the person can see', async () => {
    await grantEveryone(VOICE_ALL);
    const open = await voiceChannel({ name: 'Open' });
    const hidden = await voiceChannel({ name: 'Hidden' });
    await overwrite(owner, hidden.id, a, 0n, P.VIEW_CHANNEL);
    await inRoom(b, hidden.id);
    await inRoom(c, open.id);
    const seenByA = (await t.http.get(`/api/teams/${teamId}/voice`).set(a.auth))
      .body as VoiceChannelStateDto[];
    expect(seenByA.map((s) => s.channelId)).toEqual([open.id]);
    expect(seenByA[0]?.participants.map((p) => p.userId)).toEqual([c.id]);
    expect((await t.http.get(`/api/channels/${hidden.id}/voice`).set(a.auth)).status).toBe(404);
    expect((await t.http.get(`/api/teams/${teamId}/voice`).set(outsider.auth)).status).toBe(404);

    // the room of a hidden channel is not joinable either
    const sock = await connect(url, a);
    expect(await ack(sock, 'room:join', { kind: 'channel', id: hidden.id })).toEqual({ ok: false });
    expect(await ack(sock, 'room:join', { kind: 'channel', id: open.id })).toEqual({ ok: true });
  });
});
