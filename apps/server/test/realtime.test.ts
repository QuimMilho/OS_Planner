import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  IDLE_AFTER_MS,
  REALTIME_LIMITS,
  type PermissionsChanged,
  type PresenceUpdate,
} from '@os-planner/shared';
import { TokenService } from '../src/auth/token.service.js';
import { EventBus } from '../src/events/event-bus.js';
import { PresenceService } from '../src/realtime/presence.service.js';
import { RealtimeServer } from '../src/realtime/realtime.server.js';
import { createTestApp, GOOD_PASSWORD, type TestApp } from './app.js';
import { signup, uuid, type Account } from './helpers.js';
import {
  ack,
  closed,
  closeSockets,
  collect,
  connect,
  listen,
  next,
  refused,
  sleep,
} from './sockets.js';

const ADMIN_EMAIL = `rt-admin${Date.now()}@example.com`;

let t: TestApp;
let url: string;
let saved: string | undefined;
let admin: Account;
let alice: Account;
let bob: Account;
let carol: Account;

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
  await t.prisma.user.deleteMany();
  admin = await signup(t, true, ADMIN_EMAIL);
  alice = await signup(t);
  bob = await signup(t);
  carol = await signup(t);
});
afterEach(() => closeSockets());

// ------------------------------------------------------------------ helpers

const sessionOf = async (who: Account): Promise<string> =>
  (await t.app.get(TokenService).verifyAccess(who.token))!.sessionId;
const publish = (rooms: string[], name: string, payload: unknown = { n: 1 }) =>
  t.app.get(EventBus).publish('room.event', { rooms, name, payload });

/** A team owned by `owner`, with the others as plain members (a real join, so the audit log and events run). */
async function newTeam(owner: Account, members: Account[] = []) {
  const res = await t.http
    .post('/api/admin/teams')
    .set(admin.auth)
    .send({ name: 'Rocket', ownerEmail: owner.email, isPublic: true, joinPolicy: 'open' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const m of members)
    expect((await t.http.post(`/api/teams/${res.body.id}/join`).set(m.auth).send({})).status).toBe(
      200,
    );
  const team = await t.prisma.team.findUniqueOrThrow({ where: { id: res.body.id } });
  return { id: team.id, spaceId: team.spaceId };
}

// ------------------------------------------------------------------ handshake and tokens

describe('the handshake', () => {
  it('refuses a missing token, a media token, garbage and an expired token; accepts a valid one', async () => {
    expect(await refused(url, null)).toBe('unauthorized');
    expect(await refused(url, 'not-a-token-at-all')).toBe('unauthorized');
    const media = await t.http.post('/api/auth/media-token').set(alice.auth);
    expect(await refused(url, media.body.token as string)).toBe('unauthorized');
    const expired = await t.app.get(TokenService).signAccess(alice.id, await sessionOf(alice), -30);
    expect(await refused(url, expired)).toBe('unauthorized');

    const socket = await connect(url, alice);
    expect(socket.connected).toBe(true);
  });

  it('keeps a connection while it sends new tokens and closes it when the token runs out', async () => {
    const tokens = t.app.get(TokenService);
    const sid = await sessionOf(alice);
    const socket = await connect(url, await tokens.signAccess(alice.id, sid, 2));

    // A new token for the same login pushes the end back.
    expect(
      await ack(socket, 'auth:refresh', { token: await tokens.signAccess(alice.id, sid, 6) }),
    ).toEqual({ ok: true });
    await sleep(2800);
    expect(socket.connected).toBe(true);

    // Someone else's token, or another login's, closes it.
    const stranger = await connect(url, await tokens.signAccess(alice.id, sid, 60));
    expect(await ack(stranger, 'auth:refresh', { token: bob.token })).toEqual({ ok: false });
    expect(await closed(stranger)).toBeTruthy();

    // Without a refresh the original lifetime applies.
    const short = await connect(url, await tokens.signAccess(alice.id, sid, 1));
    const reason = await closed(short, 5000);
    expect(reason).toBe('io server disconnect');
    expect(short.connected).toBe(false);
  });

  it('refuses an origin that is neither APP_URL nor in CORS_ORIGINS, and lets the website in', async () => {
    expect(await refused(url, alice, { origin: 'https://evil.example' })).toMatch(/./);
    const site = new URL(process.env.APP_URL ?? 'http://localhost:4200').origin;
    expect((await connect(url, alice, { origin: site })).connected).toBe(true);
  });
});

// ------------------------------------------------------------------ rooms

describe('rooms', () => {
  it('answers {ok:false} the same way for a room the person may not see and for one that does not exist', async () => {
    const team = await newTeam(alice);
    const sa = await connect(url, alice);
    const sb = await connect(url, bob);

    expect(await ack(sa, 'room:join', { kind: 'space', id: team.spaceId })).toEqual({ ok: true });
    const hidden = await ack(sb, 'room:join', { kind: 'space', id: team.spaceId });
    const missing = await ack(sb, 'room:join', { kind: 'space', id: uuid() });
    expect(hidden).toEqual({ ok: false });
    expect(missing).toEqual(hidden);
    // A room kind the server owns, a kind nobody registered and a malformed id all say the same thing.
    for (const bad of [
      { kind: 'user', id: alice.id },
      { kind: 'team', id: team.id },
      { kind: 'channel', id: uuid() },
      { kind: 'space', id: 'x' },
    ]) {
      expect(await ack(sb, 'room:join', bad)).toEqual({ ok: false });
    }
  });

  it('delivers an event to the people in that room and to nobody else', async () => {
    const team = await newTeam(alice, [bob]);
    const sa = await connect(url, alice);
    const sb = await connect(url, bob);
    const sc = await connect(url, carol);
    const seenB = collect(sb, 'ping.test');
    const seenC = collect(sc, 'ping.test');
    expect(await ack(sa, 'room:join', { kind: 'space', id: team.spaceId })).toEqual({ ok: true });
    expect(await ack(sb, 'room:join', { kind: 'space', id: team.spaceId })).toEqual({ ok: true });
    expect(await ack(sc, 'room:join', { kind: 'space', id: team.spaceId })).toEqual({ ok: false });

    const heard = next(sa, 'ping.test');
    await publish([`space:${team.spaceId}`], 'ping.test', { n: 7 });
    expect(await heard).toEqual({ n: 7 });
    await sleep(300);
    expect(seenB).toEqual([{ n: 7 }]);
    expect(seenC).toEqual([]);
  });

  it('tells a space it changed when something in it is written', async () => {
    const sa = await connect(url, alice);
    const space = await t.prisma.space.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(await ack(sa, 'room:join', { kind: 'space', id: space.id })).toEqual({ ok: true });
    const changed = next<{ spaceId: string; seq: string }>(sa, 'space.changed');
    const res = await t.http
      .post('/api/notebooks')
      .set(alice.auth)
      .send({ id: uuid(), name: 'Realtime', position: 'a0' });
    expect(res.status).toBe(201);
    const event = await changed;
    expect(event.spaceId).toBe(space.id);
    expect(Number(event.seq)).toBeGreaterThan(0);
  });

  it('refuses a join once the connection is in too many rooms', async () => {
    const sa = await connect(url, alice);
    // Only the person's own spaces can be joined with no team: fake the count through the room set on the server.
    const server = t.app.get(RealtimeServer);
    const mine = [...server.io.of('/').sockets.values()].find((s) => s.data.userId === alice.id)!;
    for (let i = 0; i < REALTIME_LIMITS.roomsPerSocket; i++) await mine.join(`filler:${i}`);
    const space = await t.prisma.space.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(await ack(sa, 'room:join', { kind: 'space', id: space.id })).toEqual({ ok: false });
  });
});

// ------------------------------------------------------------------ revocation

describe('revocation', () => {
  it('drops a removed member from every room before the request that removed them answers', async () => {
    const team = await newTeam(alice, [bob]);
    const sa = await connect(url, alice);
    const sb = await connect(url, bob);
    expect(await ack(sb, 'room:join', { kind: 'space', id: team.spaceId })).toEqual({ ok: true });
    const seenB = collect(sb, 'after.removal');
    const changed = next<PermissionsChanged>(sb, 'permissions.changed');

    const res = await t.http.delete(`/api/teams/${team.id}/members/${bob.id}`).set(alice.auth);
    expect(res.status).toBe(204);
    // No waiting: the removal has already taken effect when the answer arrives.
    await publish([`space:${team.spaceId}`, `team:${team.id}`], 'after.removal');
    expect(await changed).toEqual({ teamId: team.id });
    await sleep(300);
    expect(seenB).toEqual([]);
    expect(sa.connected).toBe(true);
    expect(await ack(sb, 'room:join', { kind: 'space', id: team.spaceId })).toEqual({ ok: false });
  });

  it('puts a new member in the rooms of their team and tells the others to refresh', async () => {
    const team = await newTeam(alice);
    const sa = await connect(url, alice);
    const sb = await connect(url, bob);
    const told = next<PermissionsChanged>(sa, 'permissions.changed');
    expect((await t.http.post(`/api/teams/${team.id}/join`).set(bob.auth).send({})).status).toBe(
      200,
    );
    expect(await told).toEqual({ teamId: team.id });
    const heard = next(sb, 'team.news');
    await publish([`team:${team.id}`], 'team.news');
    await heard;
  });

  it('closes the sockets of a login that signs out and leaves everyone else alone', async () => {
    const agent = t.agent();
    const login = await agent
      .post('/api/auth/login')
      .send({ email: alice.email, password: GOOD_PASSWORD });
    expect(login.status).toBe(200);
    const mine = await connect(url, login.body.accessToken as string);
    const another = await connect(url, alice); // a second login of the same person
    const other = await connect(url, bob);

    const notice = next(mine, 'session.revoked');
    const res = await agent.post('/api/auth/logout').set('X-Requested-With', 'os_planner');
    expect(res.status).toBe(204);
    expect(await notice).toEqual({ reason: 'signed_out' });
    await closed(mine);
    await sleep(200);
    expect(another.connected).toBe(true);
    expect(other.connected).toBe(true);
    // The access token of the ended login no longer opens a connection either.
    expect(await refused(url, login.body.accessToken as string)).toBe('unauthorized');
  });

  it('closes the other logins when one of them is revoked or the password changes', async () => {
    const agent = t.agent();
    const login = await agent
      .post('/api/auth/login')
      .send({ email: alice.email, password: GOOD_PASSWORD });
    const current = await connect(url, login.body.accessToken as string);
    const first = await connect(url, alice);

    const gone = closed(first);
    const sessionId = await sessionOf(alice);
    expect((await t.http.delete(`/api/me/sessions/${sessionId}`).set(alice.auth)).status).toBe(204);
    await gone;
    expect(current.connected).toBe(true);

    const second = await connect(url, bob);
    const newer = await t.http
      .post('/api/auth/login')
      .send({ email: bob.email, password: GOOD_PASSWORD });
    const stays = await connect(url, newer.body.accessToken as string);
    const ends = closed(second);
    const change = await t.http
      .post('/api/me/password')
      .set({ Authorization: `Bearer ${newer.body.accessToken}` })
      .send({ currentPassword: GOOD_PASSWORD, newPassword: 'another horse battery' });
    expect(change.status).toBe(204);
    await ends;
    expect(stays.connected).toBe(true);
  });
});

// ------------------------------------------------------------------ presence

describe('presence', () => {
  it('announces a person to the teams they share, keeps them online until the last connection closes, and throttles', async () => {
    const team = await newTeam(alice, [bob]);
    const sb = await connect(url, bob);
    const seen = collect<PresenceUpdate>(sb, 'presence.update');

    const first = await connect(url, alice);
    await sleep(500);
    expect(seen.filter((u) => u.userId === alice.id)).toEqual([
      { userId: alice.id, status: 'online', lastSeen: null },
    ]);
    const snapshot = await t.http.get(`/api/teams/${team.id}/presence`).set(bob.auth);
    expect(snapshot.body.online.map((u: PresenceUpdate) => u.userId).sort()).toEqual(
      [alice.id, bob.id].sort(),
    );

    // A second tab, then the first closes: still online, nothing announced.
    const second = await connect(url, alice);
    first.disconnect();
    await sleep(500);
    expect(seen.filter((u) => u.userId === alice.id)).toHaveLength(1);

    // The last one closes: offline, but not before the five-second pause since the last announcement is over.
    second.disconnect();
    const offline = await new Promise<PresenceUpdate>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never announced offline')), 9000);
      sb.on('presence.update', (u: PresenceUpdate) => {
        if (u.userId === alice.id && u.status === 'offline') {
          clearTimeout(timer);
          resolve(u);
        }
      });
    });
    expect(offline.lastSeen).toMatch(/^\d{4}-/);
    expect(
      (await t.http.get(`/api/teams/${team.id}/presence`).set(bob.auth)).body.online.map(
        (u: PresenceUpdate) => u.userId,
      ),
    ).toEqual([bob.id]);
    // Outsiders cannot ask.
    expect((await t.http.get(`/api/teams/${team.id}/presence`).set(carol.auth)).status).toBe(404);
  });

  it('collapses a burst of reconnects into at most one announcement per pause', async () => {
    await newTeam(alice, [bob]);
    const sb = await connect(url, bob);
    const seen = collect<PresenceUpdate>(sb, 'presence.update');
    for (let i = 0; i < 4; i++) {
      const s = await connect(url, alice);
      await sleep(100);
      s.disconnect();
      await sleep(100);
    }
    await sleep(800);
    expect(seen.filter((u) => u.userId === alice.id).length).toBeLessThanOrEqual(2);
  });

  it('turns idle without activity pings and online again with one', async () => {
    await newTeam(alice, [bob]);
    const sb = await connect(url, bob);
    const sa = await connect(url, alice);
    await sleep(5300); // past the pause that follows the announcement of alice coming online
    const seen = collect<PresenceUpdate>(sb, 'presence.update');
    // Five minutes later with no activity from alice.
    await t.app.get(PresenceService).refresh(alice.id, Date.now() + IDLE_AFTER_MS + 1000);
    await sleep(300);
    expect(seen.filter((u) => u.userId === alice.id).at(-1)).toMatchObject({ status: 'idle' });

    await sleep(5200); // the pause after an announcement
    expect(await ack(sa, 'presence:activity', { active: true })).toEqual({ ok: true });
    await t.app.get(PresenceService).refresh(alice.id);
    await sleep(300);
    expect(seen.filter((u) => u.userId === alice.id).at(-1)).toMatchObject({ status: 'online' });
  }, 30000);

  it('shows an invisible person as offline and keeps them out of the team snapshot', async () => {
    const team = await newTeam(alice, [bob]);
    const sb = await connect(url, bob);
    await connect(url, alice);
    await sleep(400);
    const seen = collect<PresenceUpdate>(sb, 'presence.update');
    const patch = await t.http.patch('/api/me').set(alice.auth).send({ presenceMode: 'invisible' });
    expect(patch.status).toBe(200);
    expect(patch.body.presenceMode).toBe('invisible');
    await sleep(5600);
    expect(seen.filter((u) => u.userId === alice.id).at(-1)).toMatchObject({ status: 'offline' });
    const snapshot = await t.http.get(`/api/teams/${team.id}/presence`).set(bob.auth);
    expect(snapshot.body.online.map((u: PresenceUpdate) => u.userId)).toEqual([bob.id]);
  }, 20000);
});

// ------------------------------------------------------------------ limits

describe('limits', () => {
  it('allows five connections per person and refuses the sixth', async () => {
    for (let i = 0; i < REALTIME_LIMITS.socketsPerUser; i++) await connect(url, alice);
    expect(await refused(url, alice)).toBe('too_many_connections');
    expect((await connect(url, bob)).connected).toBe(true); // other people are not affected
  });

  it('drops unknown events, malformed payloads and floods without crashing, and survives an oversized payload', async () => {
    const stats = () => t.app.get(RealtimeServer).snapshot().dropped;
    const before = stats();
    const sa = await connect(url, alice);

    sa.emit('not.an.event', { x: 1 });
    expect(await ack(sa, 'room:join', { kind: 'space' })).toEqual({ ok: false });
    expect(await ack(sa, 'room:join', 'a string')).toEqual({ ok: false });
    expect(await ack(sa, 'auth:refresh', { token: 5 })).toEqual({ ok: false });
    await sleep(200);
    const after = stats();
    expect(after.unknown).toBe(before.unknown + 1);
    expect(after.invalid).toBe(before.invalid + 3);

    for (let i = 0; i < 300; i++) sa.emit('presence:activity', { active: true });
    await sleep(500);
    expect(stats().rateLimited).toBeGreaterThan(before.rateLimited);
    expect(sa.connected).toBe(true);

    // More than the 1 MB cap: the server closes that connection, and carries on for everybody else.
    const big = await connect(url, bob);
    const gone = closed(big, 6000);
    big.emit('presence:activity', { active: true, pad: 'x'.repeat(2_000_000) });
    await gone;
    expect((await t.http.get('/api/health')).body).toMatchObject({ ok: true, realtime: 'ok' });
    expect((await connect(url, bob)).connected).toBe(true);
  });

  it('shows the counters to administrators only', async () => {
    await connect(url, alice);
    const res = await t.http.get('/api/admin/realtime').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ redis: false });
    expect(res.body.sockets).toBeGreaterThanOrEqual(1);
    expect((await t.http.get('/api/admin/realtime').set(alice.auth)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ several instances

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
  });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

describe('two server instances', () => {
  it('share events through Redis, and do not without it', async () => {
    const withRedis = await redisAvailable();
    // Without a Redis there is nothing to test here; the compose profile "scale" provides one.
    expect(withRedis, 'start Redis: docker compose --profile scale up -d redis').toBe(true);

    const team = await newTeam(alice, [bob]);
    const spaceRoom = `space:${team.spaceId}`;

    const run = async (redis: string | undefined): Promise<boolean> => {
      const savedRedis = process.env.REDIS_URL;
      if (redis) process.env.REDIS_URL = redis;
      else delete process.env.REDIS_URL;
      const a = await createTestApp();
      const b = await createTestApp();
      if (savedRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = savedRedis;
      try {
        const [urlA, urlB] = [await listen(a), await listen(b)];
        const onA = await connect(urlA, alice);
        const onB = await connect(urlB, bob);
        expect(await ack(onA, 'room:join', { kind: 'space', id: team.spaceId })).toEqual({
          ok: true,
        });
        expect(await ack(onB, 'room:join', { kind: 'space', id: team.spaceId })).toEqual({
          ok: true,
        });
        const seen = collect(onB, 'across.instances');
        // Published on instance A; bob is connected to instance B.
        await a.app
          .get(EventBus)
          .publish('room.event', {
            rooms: [spaceRoom],
            name: 'across.instances',
            payload: { from: 'A' },
          });
        await sleep(700);
        expect(a.app.get(RealtimeServer).usesRedis).toBe(Boolean(redis));
        return seen.length === 1;
      } finally {
        closeSockets();
        await a.close();
        await b.close();
      }
    };

    expect(await run(REDIS_URL)).toBe(true);
    expect(await run(undefined)).toBe(false);
  }, 60000);

  it('reports the realtime server as degraded when its Redis is unreachable', async () => {
    const savedRedis = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const broken = await createTestApp();
    if (savedRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedis;
    try {
      const res = await broken.http.get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, realtime: 'degraded', redis: 'down' });
    } finally {
      await broken.close();
    }
  }, 30000);
});
