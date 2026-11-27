/**
 * The generated authorization test (phase 17).
 *
 * Every REST route is read from Nest's route table together with its `@Authz` declaration (src/common/authz.ts), and run
 * as each of these people against a real team:
 *
 *   anon        no token
 *   unverified  signed in, email not verified, not a member
 *   outsider    signed in, verified, not a member
 *   banned      was a member, banned
 *   removed     was a member, kicked out
 *   admin       instance administrator (ADMIN_EMAILS), not a member
 *   blind       a member with no permission at all (the team's @everyone grants nothing here)
 *   viewer      a member who may see everything (the VIEW_* bits and READ_MESSAGE_HISTORY) and do nothing
 *   power       a member with every permission except ADMINISTRATOR; also the author of the fixture items
 *   owner       the team's owner
 *
 * What each must get follows from the declaration alone (see `expected`). Routes whose rule needs a fresh item for every
 * call (deletes, moves, restores) get one; a few routes with their own story (leaving, handing a team over, joining) have
 * their own tests below. The test fails for a route without a declaration.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import webpush from 'web-push';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  CLIENT_EVENTS,
  COLLAB_PATH,
  JOINABLE_ROOM_KINDS,
  PERMISSION_NAMES,
  Permission,
  permissionsToString,
  positionBetween,
  type PermissionName,
} from '@os-planner/shared';
import {
  AUTHZ_ROOMS,
  AUTHZ_SOCKET_EVENTS,
  type AuthzRule,
  type AuthzScope,
} from '../src/common/authz.js';
import { createTestApp, type TestApp } from './app.js';
import { png } from './fixtures.js';
import { para, signup, uuid, uuidv7, type Account } from './helpers.js';
import { listRoutes, paramNames, sample, type RouteInfo } from './routes.js';
import { ack, closeSockets, connect, listen } from './sockets.js';

const P = Permission;
const ADMIN_EMAIL = `authz-admin${Date.now()}@example.com`;
const RELEASE_TOKEN = 'a-release-token-for-the-authorization-test';
const LK_KEY = 'APIauthzkey';
const LK_SECRET = 'an-authorization-test-livekit-secret-32+';
const PUSH_ORIGIN = 'https://push.authz.example.com';

const VIEW =
  P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY | P.VIEW_NOTEBOOKS | P.VIEW_BOARDS | P.VIEW_CALENDAR;
const POWER = ALL_PERMISSIONS & ~P.ADMINISTRATOR;

const PERSONAS = [
  'anon',
  'unverified',
  'outsider',
  'banned',
  'removed',
  'admin',
  'blind',
  'viewer',
  'power',
  'owner',
] as const;
type Persona = (typeof PERSONAS)[number];
const MEMBERS: readonly Persona[] = ['blind', 'viewer', 'power', 'owner'];
const PERMS: Partial<Record<Persona, bigint>> = {
  blind: 0n,
  viewer: VIEW,
  power: POWER,
  owner: ALL_PERMISSIONS,
};
/** Who made the fixture items (messages, tasks, comments, events, feeds, sessions...). */
const AUTHOR: Persona = 'power';
/** The two people of the fixture conversation. */
const DM_PEOPLE: readonly Persona[] = ['power', 'owner'];

type Outcome = 'ok' | 401 | 403 | 404;

const SCOPES: readonly AuthzScope[] = [
  'public',
  'secret',
  'self',
  'own',
  'admin',
  'release',
  'webhook',
  'team',
  'project',
  'space',
  'channel',
  'notebook',
  'board',
  'calendar',
  'dm',
];
const TEAM_SCOPES: readonly AuthzScope[] = [
  'team',
  'project',
  'space',
  'channel',
  'notebook',
  'board',
  'calendar',
];

/** What must the persona get, from the declaration alone. */
function expected(rule: AuthzRule, who: Persona): Outcome {
  const signedIn = who !== 'anon';
  switch (rule.scope) {
    case 'public':
    case 'secret':
      return 'ok';
    case 'admin':
      return who === 'admin' ? 'ok' : 404;
    case 'release':
    case 'webhook':
      return 401;
    case 'self':
      if (!signedIn) return 401;
      return rule.verified && who === 'unverified' ? 403 : 'ok';
    case 'own':
      if (!signedIn) return 401;
      return who === AUTHOR ? 'ok' : 404;
    case 'dm':
      if (!signedIn) return 401;
      return DM_PEOPLE.includes(who) ? 'ok' : 404;
  }
  // a place in a team
  if (!signedIn) return 401;
  if (rule.verified && who === 'unverified') return 403;
  const perms = PERMS[who];
  if (perms === undefined) return 404;
  if (!visible(rule.scope, perms)) return 404;
  if (rule.ownerOnly) return who === 'owner' ? 'ok' : (rule.denied ?? 403);
  if (rule.author === 'only') return who === AUTHOR ? 'ok' : (rule.denied ?? 403);
  if (rule.author === 'or' && who === AUTHOR) return 'ok';
  const lacks =
    (rule.needs ?? []).some((n) => (perms & P[n]) === 0n) ||
    (rule.anyOf !== undefined && rule.anyOf.every((n) => (perms & P[n]) === 0n));
  return lacks ? (rule.denied ?? 403) : 'ok';
}

function visible(scope: AuthzScope, perms: bigint): boolean {
  if (perms === ALL_PERMISSIONS) return true;
  switch (scope) {
    case 'channel':
      return (perms & P.VIEW_CHANNEL) !== 0n;
    case 'notebook':
      return (perms & P.VIEW_NOTEBOOKS) !== 0n;
    case 'board':
      return (perms & P.VIEW_BOARDS) !== 0n;
    case 'calendar':
      return (perms & P.VIEW_CALENDAR) !== 0n;
    case 'project':
      return (perms & (VIEW | P.MANAGE_PROJECTS)) !== 0n;
    default:
      return true;
  }
}

// ------------------------------------------------------------------ a stand-in for the media server's room API

const voiceIdentities = new Set<string>();
let fakeLiveKit: Server;
function startFakeLiveKit(): Promise<string> {
  fakeLiveKit = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop() ?? '';
      let answer: unknown = {};
      if (method === 'ListParticipants')
        answer = {
          participants: [...voiceIdentities].map((identity, i) => ({
            sid: `PA_${i}`,
            identity,
            tracks: [{ sid: `TR_${i}`, type: 'AUDIO', source: 'MICROPHONE', muted: false }],
          })),
        };
      else if (method === 'ListRooms') answer = { rooms: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  return new Promise((r) =>
    fakeLiveKit.listen(0, '127.0.0.1', () =>
      r(`127.0.0.1:${(fakeLiveKit.address() as AddressInfo).port}`),
    ),
  );
}

// ------------------------------------------------------------------ the world

let t: TestApp;
let baseUrl: string;
const saved: Record<string, string | undefined> = {};
const people = {} as Record<Exclude<Persona, 'anon'>, Account>;
let lastPos: string | null = null;
const pos = (): string => (lastPos = positionBetween(lastPos, null));

interface World {
  team: { id: string; spaceId: string; slug: string };
  project: { id: string; spaceId: string };
  everyoneRole: string;
  powerRole: string;
  viewerRole: string;
  lowRole: string;
  target: Account;
  channel: string;
  voice: string;
  voice2: string;
  message: string;
  thread: string;
  dm: { id: string; channelId: string };
  notebook: string;
  /** A notebook of power's own space (direct shares are for those). */
  personalNotebook: string;
  category: string;
  page: string;
  snapshot: string;
  linkMedia: string;
  personalMedia: string;
  link: { id: string; token: string };
  board: string;
  columns: { todo: string; doing: string; done: string };
  task: string;
  /** Assigned to viewer, with the label. */
  task2: string;
  item: string;
  editLink: string;
  talkerRole: string;
  comment: string;
  attachment: string;
  label: string;
  event: string;
  invite: { id: string; token: string };
  overwrite: string;
  feed: { id: string; file: string };
  external: string;
  setting: string;
  device: string;
  share: string;
  pending: string;
  request: string;
}
let w: World;

const bearer = (a: Account | null | undefined): Record<string, string> => (a ? a.auth : {});
const accountOf = (p: Persona): Account | null => (p === 'anon' ? null : people[p]);

async function ok<T = any>(res: { status: number; body: unknown }, what: string): Promise<T> {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as T;
}
const as = (who: Account) => ({
  get: (p: string) => t.http.get(p).set(who.auth),
  post: (p: string, body?: object) =>
    t.http
      .post(p)
      .set(who.auth)
      .send(body ?? {}),
  put: (p: string, body?: object) =>
    t.http
      .put(p)
      .set(who.auth)
      .send(body ?? {}),
  patch: (p: string, body?: object) =>
    t.http
      .patch(p)
      .set(who.auth)
      .send(body ?? {}),
  del: (p: string, body?: object) =>
    t.http
      .delete(p)
      .set(who.auth)
      .send(body ?? {}),
});

/** Things a single call may consume: each call gets its own. */
const make = {
  member: async (): Promise<Account> => {
    const a = await signup(t);
    await t.prisma.teamMember.create({ data: { teamId: w.team.id, userId: a.id } });
    return a;
  },
  channel: async () =>
    (
      await ok(
        await as(people.owner).post(`/api/spaces/${w.team.spaceId}/channels`, {
          name: `c${Date.now() % 1e6}`,
        }),
        'channel',
      )
    ).id as string,
  message: async () =>
    (
      await ok(
        await as(people.power).post(`/api/channels/${w.channel}/messages`, {
          id: uuidv7(),
          content: 'hello',
        }),
        'message',
      )
    ).id as string,
  notebook: async () => {
    const id = uuid();
    await ok(
      await as(people.owner).post('/api/notebooks', {
        id,
        spaceId: w.team.spaceId,
        name: 'Fresh',
        position: pos(),
      }),
      'notebook',
    );
    return id;
  },
  category: async () => {
    const id = uuid();
    await ok(
      await as(people.owner).post('/api/categories', {
        id,
        notebookId: w.notebook,
        name: 'Fresh',
        position: pos(),
      }),
      'category',
    );
    return id;
  },
  page: async () => {
    const id = uuid();
    await ok(
      await as(people.owner).post('/api/pages', {
        id,
        categoryId: w.category,
        title: 'Fresh',
        position: pos(),
      }),
      'page',
    );
    return id;
  },
  board: async () => {
    const id = uuid();
    await ok(
      await as(people.owner).post(`/api/spaces/${w.team.spaceId}/boards`, {
        id,
        name: 'Fresh',
        position: pos(),
      }),
      'board',
    );
    return id;
  },
  column: async () => {
    const id = uuid();
    await ok(
      await as(people.owner).post(`/api/boards/${w.board}/columns`, {
        id,
        name: 'Fresh',
        position: pos(),
      }),
      'column',
    );
    return id;
  },
  label: async () => {
    const id = uuid();
    await ok(
      await as(people.owner).post(`/api/spaces/${w.team.spaceId}/labels`, {
        id,
        name: `l${Date.now() % 1e6}`,
        color: '#336699',
      }),
      'label',
    );
    return id;
  },
  task: async () => {
    const id = uuid();
    await ok(
      await as(people.power).post(`/api/boards/${w.board}/tasks`, {
        id,
        columnId: w.columns.todo,
        position: pos(),
        title: 'Fresh',
      }),
      'task',
    );
    return id;
  },
  trashedTask: async () => {
    const id = await make.task();
    await ok(await as(people.power).del(`/api/tasks/${id}`), 'trash task');
    return id;
  },
  item: async () => {
    const id = uuid();
    await ok(
      await as(people.power).post(`/api/tasks/${w.task}/checklist`, {
        id,
        text: 'Fresh',
        position: pos(),
      }),
      'item',
    );
    return id;
  },
  comment: async () => {
    const id = uuid();
    await ok(
      await as(people.power).post(`/api/tasks/${w.task}/comments`, { id, content: 'Fresh' }),
      'comment',
    );
    return id;
  },
  attachment: async () => {
    const res = await t.http
      .post(`/api/tasks/${w.task}/attachments`)
      .set(people.power.auth)
      .field('id', uuid())
      .attach('file', await png(), 'a.png');
    return (await ok(res, 'attachment')).id as string;
  },
  event: async () => {
    const id = uuid();
    const start = new Date(Date.now() + 86_400_000);
    await ok(
      await as(people.power).post('/api/events', {
        id,
        spaceId: w.team.spaceId,
        title: 'Fresh',
        kind: 'meeting',
        visibility: 'space',
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() + 3_600_000).toISOString(),
      }),
      'event',
    );
    return id;
  },
  project: async () => {
    const id = (
      await ok(
        await as(people.owner).post(`/api/teams/${w.team.id}/projects`, {
          name: 'Fresh',
          position: pos(),
        }),
        'project',
      )
    ).id as string;
    for (const who of [people.viewer, people.blind])
      await ok(
        await as(people.owner).post(`/api/projects/${id}/members`, { userId: who.id }),
        'project member',
      );
    return id;
  },
  role: async () =>
    (
      await ok(
        await as(people.owner).post(`/api/teams/${w.team.id}/roles`, {
          name: `r${Date.now() % 1e6}`,
        }),
        'role',
      )
    ).id as string,
  overwrite: async () => {
    const target = await make.member();
    const res = await as(people.owner).put('/api/overwrites', {
      targetKind: 'project',
      targetId: w.project.id,
      subjectKind: 'member',
      subjectId: target.id,
      allow: permissionsToString(P.VIEW_CHANNEL),
    });
    return (await ok(res, 'overwrite')).id as string;
  },
  invite: async () => {
    const email = `invitee${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    const res = await as(people.owner).post(`/api/teams/${w.team.id}/invites`, { email });
    const invite = await ok(res, 'invite');
    return { id: invite.id as string, token: t.mail.last('invite', email)!.token };
  },
  link: async () => {
    const link = await ok(
      await as(people.owner).post(`/api/notebooks/${w.notebook}/links`, { access: 'read' }),
      'link',
    );
    return { id: link.id as string, token: link.token as string };
  },
  share: async () => {
    const to = await make.member();
    const res = await as(people.power).put(`/api/notebooks/${w.personalNotebook}/shares`, {
      userId: to.id,
      access: 'read',
    });
    return (await ok(res, 'share')).share.id as string;
  },
  pending: async () => {
    await ok(
      await as(people.power).put(`/api/notebooks/${w.personalNotebook}/shares`, {
        email: `pending${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`,
        access: 'read',
      }),
      'pending share',
    );
    const row = await t.prisma.pendingShare.findFirstOrThrow({
      where: { notebookId: w.personalNotebook },
      orderBy: { createdAt: 'desc' },
    });
    return row.id;
  },
  feed: async () => {
    const feed = await ok(await as(people.power).post('/api/me/feeds', { name: 'Feed' }), 'feed');
    return { id: feed.id as string, file: String(feed.url).split('/').pop()! };
  },
  external: async () => {
    const row = await t.prisma.externalCalendar.create({
      data: {
        id: uuid(),
        userId: people.power.id,
        name: 'Holidays',
        url: 'https://calendar.example.com/x.ics',
        color: '#336699',
        nextSyncAt: new Date(Date.now() + 86_400_000),
      },
    });
    return row.id;
  },
  setting: async () => {
    const team = await make.project();
    const res = await as(people.power).put('/api/notification-settings', {
      scopeKind: 'project',
      scopeId: team,
      level: 'all',
    });
    return (await ok(res, 'setting')).id as string;
  },
  device: async () => {
    const res = await as(people.power).post('/api/push/subscribe', {
      endpoint: `${PUSH_ORIGIN}/${uuid()}`,
      keys: {
        p256dh:
          'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
        auth: 'tBHItJI5svbpez7KI4CCXg',
      },
    });
    return (await ok(res, 'device')).id as string;
  },
  session: async () => {
    const res = await t.http
      .post('/api/auth/login')
      .send({ email: people.power.email, password: 'correct horse battery' });
    await ok(res, 'login');
    const sessions = await ok<{ id: string; current: boolean }[]>(
      await as(people.power).get('/api/me/sessions'),
      'sessions',
    );
    return sessions.filter((s) => !s.current).at(-1)!.id;
  },
  request: async () => {
    const who = await signup(t);
    await ok(await as(who).post(`/api/teams/${w.team.id}/join`, {}), 'join request');
    return (
      await t.prisma.joinRequest.findFirstOrThrow({ where: { teamId: w.team.id, userId: who.id } })
    ).id;
  },
  banned: async () => {
    const who = await make.member();
    await ok(await as(people.owner).put(`/api/teams/${w.team.id}/bans/${who.id}`, {}), 'ban');
    return who.id;
  },
  inVoice: async () => {
    const who = await make.member();
    await ok(
      await as(people.owner).put(`/api/teams/${w.team.id}/members/${who.id}/roles/${w.talkerRole}`),
      'talker',
    );
    await t.prisma.voiceParticipant.create({
      data: { channelId: w.voice, userId: who.id, sid: `PA_${who.id.slice(0, 8)}` },
    });
    voiceIdentities.add(who.id);
    return who.id;
  },
  team: async () =>
    (
      await ok(
        await as(people.admin).post('/api/admin/teams', {
          name: 'Fresh team',
          ownerEmail: people.owner.email,
        }),
        'team',
      )
    ).id as string,
};

async function trashed(kind: 'notebook' | 'category' | 'page' | 'board'): Promise<string> {
  const id = await make[kind]();
  const path =
    kind === 'board'
      ? `/api/boards/${id}`
      : `/api/${kind === 'category' ? 'categories' : `${kind}s`}/${id}`;
  await ok(await as(people.owner).del(path), `trash ${kind}`);
  return id;
}

async function buildWorld(): Promise<World> {
  const owner = people.owner;
  const teamRes = await as(people.admin).post('/api/admin/teams', {
    name: 'Authz',
    ownerEmail: owner.email,
    isPublic: true,
    joinPolicy: 'request',
  });
  const teamId = (await ok(teamRes, 'team')).id as string;
  const teamRow = await t.prisma.team.findUniqueOrThrow({ where: { id: teamId } });
  w = { team: { id: teamId, spaceId: teamRow.spaceId, slug: teamRow.slug } } as World;
  await ok(
    await as(owner).patch(`/api/teams/${teamId}`, { allowPublicLinks: true, allowMemberDMs: true }),
    'team settings',
  );
  for (const p of ['power', 'viewer', 'blind', 'banned', 'removed'] as const)
    await t.prisma.teamMember.create({ data: { teamId, userId: people[p].id } });

  // @everyone grants nothing, so each persona holds exactly its role
  const everyone = await t.prisma.role.findFirstOrThrow({ where: { teamId, isEveryone: true } });
  w.everyoneRole = everyone.id;
  await ok(await as(owner).patch(`/api/roles/${everyone.id}`, { permissions: '0' }), 'everyone');
  // the higher role first: a new role starts at the bottom
  w.powerRole = (
    await ok(
      await as(owner).post(`/api/teams/${teamId}/roles`, {
        name: 'Power',
        permissions: permissionsToString(POWER),
      }),
      'power role',
    )
  ).id;
  w.viewerRole = (
    await ok(
      await as(owner).post(`/api/teams/${teamId}/roles`, {
        name: 'Viewer',
        permissions: permissionsToString(VIEW),
      }),
      'viewer role',
    )
  ).id;
  // people moderated in voice: they may talk, and rank below everybody else
  w.talkerRole = (
    await ok(
      await as(owner).post(`/api/teams/${teamId}/roles`, {
        name: 'Talker',
        permissions: permissionsToString(P.VIEW_CHANNEL | P.CONNECT | P.SPEAK),
      }),
      'talker role',
    )
  ).id;
  w.lowRole = await make.role();
  await ok(
    await as(owner).put(`/api/teams/${teamId}/members/${people.power.id}/roles/${w.powerRole}`),
    'assign power',
  );
  await ok(
    await as(owner).put(`/api/teams/${teamId}/members/${people.viewer.id}/roles/${w.viewerRole}`),
    'assign viewer',
  );
  await ok(await as(owner).put(`/api/teams/${teamId}/bans/${people.banned.id}`, {}), 'ban');
  await ok(await as(owner).del(`/api/teams/${teamId}/members/${people.removed.id}`), 'kick');
  w.target = await make.member();

  const project = await ok(
    await as(owner).post(`/api/teams/${teamId}/projects`, { name: 'Project', position: pos() }),
    'project',
  );
  w.project = { id: project.id, spaceId: project.spaceId };
  // a project shows to its members who hold a VIEW_* bit (and to whoever has MANAGE_PROJECTS)
  for (const who of [w.target, people.viewer, people.blind])
    await ok(
      await as(owner).post(`/api/projects/${project.id}/members`, { userId: who.id }),
      'project member',
    );

  w.channel = await make.channel();
  w.voice = (
    await ok(
      await as(owner).post(`/api/spaces/${w.team.spaceId}/channels`, {
        name: 'voice',
        kind: 'voice',
      }),
      'voice',
    )
  ).id;
  w.voice2 = (
    await ok(
      await as(owner).post(`/api/spaces/${w.team.spaceId}/channels`, {
        name: 'voice-2',
        kind: 'voice',
      }),
      'voice 2',
    )
  ).id;
  w.message = await make.message();
  w.thread = (
    await ok(
      await as(people.power).post(`/api/messages/${w.message}/thread`, { name: 'Thread' }),
      'thread',
    )
  ).id;
  const dm = await ok(await as(people.power).post('/api/dms', { userId: owner.id }), 'dm');
  w.dm = { id: dm.id, channelId: dm.channelId };

  w.notebook = uuid();
  await ok(
    await as(owner).post('/api/notebooks', {
      id: w.notebook,
      spaceId: w.team.spaceId,
      name: 'Team notes',
      position: pos(),
    }),
    'notebook',
  );
  w.category = await make.category();
  w.page = await make.page();
  const media = await t.http
    .post('/api/media')
    .set(owner.auth)
    .field('id', uuid())
    .field('notebookId', w.notebook)
    .attach('file', await png(), 'p.png');
  w.linkMedia = (await ok(media, 'media')).id;
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
      {
        type: 'imageFigure',
        attrs: { mediaId: w.linkMedia, alt: '', caption: '', width: null, align: 'center' },
      },
    ],
  };
  await ok(
    await as(owner).post(`/api/pages/${w.page}/snapshots/replace`, { content: doc }),
    'content',
  );
  w.snapshot = (await t.prisma.pageYSnapshot.findFirstOrThrow({ where: { pageId: w.page } })).id;
  const mine = await t.http
    .post('/api/media')
    .set(people.power.auth)
    .field('id', uuid())
    .attach('file', await png(), 'mine.png');
  w.personalMedia = (await ok(mine, 'personal media')).id;
  w.link = await make.link();
  w.personalNotebook = uuid();
  await ok(
    await as(people.power).post('/api/notebooks', {
      id: w.personalNotebook,
      name: 'Mine',
      position: pos(),
    }),
    'personal notebook',
  );
  w.share = await make.share();
  w.pending = await make.pending();

  w.board = await make.board();
  const detail = await ok(await as(owner).get(`/api/boards/${w.board}`), 'board detail');
  const col = (k: string) =>
    (detail.columns as { id: string; kind: string }[]).find((c) => c.kind === k)!.id;
  w.columns = { todo: col('todo'), doing: col('doing'), done: col('done') };
  w.task = await make.task();
  w.label = await make.label();
  // people and labels are changed on a task of its own: an assignee counts as one of a task's own people
  w.task2 = await make.task();
  await ok(
    await as(people.power).patch(`/api/tasks/${w.task2}`, {
      assigneeIds: [people.viewer.id],
      labelIds: [w.label],
    }),
    'task people',
  );
  w.item = await make.item();
  w.comment = await make.comment();
  w.attachment = await make.attachment();
  w.event = await make.event();
  // an edit link (team notebooks only have read links): on a notebook of power's of its own, since joining it shares it
  const forLinks = uuid();
  await ok(
    await as(people.power).post('/api/notebooks', {
      id: forLinks,
      name: 'Linked',
      position: pos(),
    }),
    'linked notebook',
  );
  w.editLink = (
    await ok(
      await as(people.power).post(`/api/notebooks/${forLinks}/links`, { access: 'edit' }),
      'edit link',
    )
  ).token;

  w.invite = await make.invite();
  w.overwrite = await make.overwrite();
  w.feed = await make.feed();
  w.external = await make.external();
  w.setting = await make.setting();
  w.device = await make.device();
  w.request = await make.request();
  return w;
}

// ------------------------------------------------------------------ how to call each route

interface Call {
  params: Record<string, string>;
  body?: unknown;
  query?: Record<string, unknown>;
  /** Fields of a multipart upload (the file is a small PNG). */
  fields?: Record<string, string>;
  headers?: Record<string, string>;
}

interface Case {
  /** Params, body or query for one call; `fresh` routes run it once per call. */
  call?: (who: Persona) => Promise<Partial<Call>> | Partial<Call>;
  fresh?: boolean;
  /** Statuses that also mean "allowed" for this route (the request got past authorization), with why. */
  alsoOk?: number[];
  /** Covered by a test of its own below (why). */
  own?: string;
  /** People who get something else than the declaration says, and why (a rule the declaration cannot express). */
  expect?: Partial<Record<Persona, Outcome>>;
  why?: string;
}

/** The default meaning of a path parameter. */
function defaultParam(route: RouteInfo, name: string, prev: string): string {
  if (name === 'id') {
    switch (prev) {
      case 'teams':
        return w.team.id;
      case 'projects':
        return w.project.id;
      case 'spaces':
        return w.team.spaceId;
      case 'channels':
        return route.path.includes('/voice') ? w.voice : w.channel;
      case 'messages':
        return w.message;
      case 'threads':
        return w.thread;
      case 'notebooks':
        return w.notebook;
      case 'categories':
        return w.category;
      case 'pages':
        return w.page;
      case 'boards':
        return w.board;
      case 'columns':
        return w.columns.doing;
      case 'labels':
        return w.label;
      case 'tasks':
        return w.task;
      case 'comments':
        return w.comment;
      case 'events':
        return w.event;
      case 'roles':
        return w.lowRole;
      case 'invites':
        return w.invite.id;
      case 'links':
        return w.link.id;
      case 'dms':
        return w.dm.id;
      case 'feeds':
        return w.feed.id;
      case 'external-calendars':
        return w.external;
      case 'notification-settings':
        return w.setting;
      case 'devices':
        return w.device;
      case 'overwrites':
        return w.overwrite;
      case 'media':
        return w.personalMedia;
    }
  }
  const named: Record<string, string> = {
    userId: w.target.id,
    roleId: w.lowRole,
    labelId: w.label,
    itemId: w.item,
    attachmentId: w.attachment,
    shareId: w.share,
    pendingId: w.pending,
    notebookId: w.notebook,
    pageId: w.page,
    snapshotId: w.snapshot,
    rid: w.request,
    emoji: '👍',
    kind: 'user',
    subjectId: people.viewer.id,
    slug: w.team.slug,
    token: w.link.token,
    mediaId: w.linkMedia,
    file: w.feed.file,
    name: 'latest.yml',
    scope: 'team',
  };
  if (named[name]) return named[name]!;
  throw new Error(`${route.key}: nothing known for :${name}`);
}

const fresh = (
  params: (who: Persona) => Promise<Record<string, string>>,
  extra: Omit<Partial<Call>, 'params'> = {},
): Case => ({
  fresh: true,
  call: async (who) => ({ params: await params(who), ...extra }),
});
const freshId = (f: () => Promise<string>, extra: Omit<Partial<Call>, 'params'> = {}): Case =>
  fresh(async () => ({ id: await f() }), extra);

/** Routes that need more than the defaults. */
function cases(): Record<string, Case> {
  return {
    // ---- admin
    'DELETE /api/admin/teams/:id': freshId(make.team),
    'GET /api/admin/quotas/:scope/:id': {
      call: () => ({ params: { scope: 'team', id: w.team.id } }),
    },
    'PUT /api/admin/quotas/:scope/:id': {
      call: () => ({ params: { scope: 'team', id: w.team.id }, body: {} }),
    },
    'DELETE /api/admin/quotas/:scope/:id': {
      call: () => ({ params: { scope: 'team', id: w.team.id } }),
    },
    'POST /api/admin/teams': {
      call: () => ({ body: { name: 'Another', ownerEmail: people.owner.email } }),
    },

    // ---- auth (the rules of signing in are tested in auth.test; here: who may call)
    'POST /api/auth/register': {
      call: () => ({
        body: {
          email: `reg${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`,
          password: 'correct horse battery',
          displayName: 'New',
        },
      }),
    },
    'POST /api/auth/login': {
      call: () => ({ body: { email: people.viewer.email, password: 'correct horse battery' } }),
    },
    'POST /api/auth/refresh': {
      own: 'cookie sessions: auth.test (refresh needs the cookie and the CSRF header)',
    },
    'POST /api/auth/logout': { call: () => ({ headers: { 'X-Requested-With': 'os_planner' } }) },
    'POST /api/auth/verify-email': {
      own: 'auth.test (a token sent by mail; a wrong one is checked below)',
    },
    'POST /api/auth/reset-password': {
      own: 'auth.test (a token sent by mail; a wrong one is checked below)',
    },
    'POST /api/auth/forgot-password': { call: () => ({ body: { email: 'nobody@example.com' } }) },
    'POST /api/auth/resend-verification': { alsoOk: [409] },
    // a wrong current password (401 invalid_credentials): changing it for real would end the persona's other sessions
    'POST /api/me/password': {
      call: () => ({
        body: { currentPassword: 'wrong password here', newPassword: 'another long password' },
      }),
      alsoOk: [401],
    },
    'GET /api/directory/:slug': {
      expect: { banned: 404 },
      why: 'a banned person does not see the team in the directory',
    },
    'DELETE /api/me/sessions/:id': freshId(make.session),

    // ---- teams and membership
    'DELETE /api/teams/:id/members/me': { own: 'leaving (below)' },
    'POST /api/teams/:id/transfer-ownership': { own: 'handing a team over (below)' },
    'POST /api/teams/:id/join': { own: 'joining (below)' },
    'DELETE /api/teams/:id/join-request': { own: 'joining (below)' },
    'DELETE /api/teams/:id/members/:userId': fresh(async () => ({
      id: w.team.id,
      userId: (await make.member()).id,
    })),
    'PATCH /api/teams/:id/members/:userId': { call: () => ({ body: { nickname: 'Nick' } }) },
    'PUT /api/teams/:id/bans/:userId': fresh(
      async () => ({ id: w.team.id, userId: (await make.member()).id }),
      { body: {} },
    ),
    'DELETE /api/teams/:id/bans/:userId': fresh(async () => ({
      id: w.team.id,
      userId: await make.banned(),
    })),
    'POST /api/teams/:id/join-requests/:rid/approve': fresh(async () => ({
      id: w.team.id,
      rid: await make.request(),
    })),
    'POST /api/teams/:id/join-requests/:rid/deny': fresh(async () => ({
      id: w.team.id,
      rid: await make.request(),
    })),
    'POST /api/teams/:id/invites': {
      call: () => ({
        body: { email: `inv${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com` },
      }),
    },
    'DELETE /api/invites/:id': fresh(async () => ({ id: (await make.invite()).id })),
    'GET /api/invites/preview': { call: () => ({ query: { token: w.invite.token } }) },
    'POST /api/invites/accept': { own: 'joining (below): accepting makes the person a member' },
    'PATCH /api/teams/:id': { call: () => ({ body: { description: 'Edited' } }) },
    'POST /api/teams/:id/projects': { call: () => ({ body: { name: 'New', position: pos() } }) },
    'DELETE /api/projects/:id': freshId(make.project),
    'POST /api/projects/:id/move': freshId(make.project, {
      body: { parentId: null, position: 'zz' },
    }),
    'POST /api/projects/:id/members': {
      call: async () => ({ body: { userId: (await make.member()).id } }),
    },
    'DELETE /api/projects/:id/members/:userId': fresh(async () => {
      const who = await make.member();
      await ok(
        await as(people.owner).post(`/api/projects/${w.project.id}/members`, { userId: who.id }),
        'project member',
      );
      return { id: w.project.id, userId: who.id };
    }),

    // ---- roles and overwrites
    'POST /api/teams/:id/roles': { call: () => ({ body: { name: `n${Date.now() % 1e6}` } }) },
    'POST /api/projects/:id/roles': { call: () => ({ body: { name: `p${Date.now() % 1e6}` } }) },
    'PUT /api/teams/:id/roles/order': { own: 'roles.test (the order of the whole list)' },
    'PUT /api/projects/:id/roles/order': { own: 'roles.test (the order of the whole list)' },
    'PUT /api/projects/:id/members/:userId/roles/:roleId': fresh(async () => {
      const role = await ok(
        await as(people.owner).post(`/api/projects/${w.project.id}/roles`, {
          name: `pr${Date.now() % 1e6}`,
        }),
        'project role',
      );
      return { id: w.project.id, userId: w.target.id, roleId: role.id };
    }),
    'DELETE /api/projects/:id/members/:userId/roles/:roleId': fresh(async () => {
      const role = await ok(
        await as(people.owner).post(`/api/projects/${w.project.id}/roles`, {
          name: `pr${Date.now() % 1e6}`,
        }),
        'project role',
      );
      return { id: w.project.id, userId: w.target.id, roleId: role.id };
    }),
    'DELETE /api/roles/:id': freshId(make.role),
    'PATCH /api/roles/:id': { call: () => ({ body: { name: 'Renamed' } }) },
    'GET /api/teams/:id/audit': { call: () => ({ query: {} }) },
    'GET /api/overwrites': { call: () => ({ query: { kind: 'project', id: w.project.id } }) },
    'PUT /api/overwrites': {
      call: () => ({
        body: {
          targetKind: 'project',
          targetId: w.project.id,
          subjectKind: 'member',
          subjectId: w.target.id,
          allow: permissionsToString(P.VIEW_BOARDS),
        },
      }),
    },
    'DELETE /api/overwrites/:id': freshId(make.overwrite),
    'GET /api/permissions/preview': {
      call: () => ({ query: { subject: `member:${w.target.id}`, kind: 'team', id: w.team.id } }),
    },

    // ---- chat
    'POST /api/spaces/:id/channels': { call: () => ({ body: { name: `n${Date.now() % 1e6}` } }) },
    'PUT /api/spaces/:id/channels/order': { own: 'chat.test (the order of the whole list)' },
    'DELETE /api/channels/:id': freshId(make.channel),
    'PATCH /api/channels/:id': { call: () => ({ body: { topic: 'Edited' } }) },
    'PUT /api/channels/:id/read': { call: () => ({ body: { messageId: w.message } }) },
    'POST /api/channels/:id/messages': { call: () => ({ body: { id: uuidv7(), content: 'hi' } }) },
    'GET /api/channels/:id/search': { call: () => ({ query: { q: 'hello' } }) },
    'POST /api/channels/:id/attachments': { call: () => ({ fields: { id: uuid() } }) },
    'PATCH /api/messages/:id': { call: () => ({ body: { content: 'edited' } }) },
    'DELETE /api/messages/:id': freshId(make.message),
    'POST /api/messages/:id/thread': freshId(make.message, { body: { name: 'New thread' } }),
    'PATCH /api/threads/:id': { call: () => ({ body: { name: 'Renamed' } }) },
    'POST /api/dms': { call: () => ({ body: { userId: people.viewer.id } }), alsoOk: [403] },
    'PUT /api/blocks/:userId': { call: () => ({ params: { userId: w.target.id } }) },
    'DELETE /api/blocks/:userId': { call: () => ({ params: { userId: w.target.id } }) },

    // ---- voice
    'POST /api/channels/:id/voice/participants/:userId/mute': fresh(async () => ({
      id: w.voice,
      userId: await make.inVoice(),
    })),
    'POST /api/channels/:id/voice/participants/:userId/unmute': fresh(async () => ({
      id: w.voice,
      userId: await make.inVoice(),
    })),
    'POST /api/channels/:id/voice/participants/:userId/move': fresh(
      async () => ({ id: w.voice, userId: await make.inVoice() }),
      { body: { toChannelId: w.voice2 } },
    ),
    'POST /api/channels/:id/voice/participants/:userId/disconnect': fresh(async () => ({
      id: w.voice,
      userId: await make.inVoice(),
    })),
    'POST /api/voice/webhook': {
      call: () => ({ headers: { 'Content-Type': 'application/webhook+json' }, body: '{}' }),
    },

    // ---- notebooks, pages, sharing
    'POST /api/notebooks': {
      call: () => ({ body: { id: uuid(), name: 'Mine', position: pos() } }),
    },
    'PATCH /api/notebooks/:id': { call: () => ({ body: { name: 'Renamed' } }) },
    'DELETE /api/notebooks/:id': freshId(make.notebook),
    'POST /api/notebooks/:id/restore': freshId(() => trashed('notebook')),
    'POST /api/notebooks/:id/move': freshId(make.notebook, {
      body: { spaceId: w.project.spaceId },
    }),
    'POST /api/categories': {
      call: () => ({ body: { id: uuid(), notebookId: w.notebook, name: 'New', position: pos() } }),
    },
    'PATCH /api/categories/:id': { call: () => ({ body: { name: 'Renamed' } }) },
    'DELETE /api/categories/:id': freshId(make.category),
    'POST /api/categories/:id/restore': freshId(() => trashed('category')),
    'POST /api/pages': {
      call: () => ({ body: { id: uuid(), categoryId: w.category, title: 'New', position: pos() } }),
    },
    'PATCH /api/pages/:id': { call: () => ({ body: { title: 'Renamed' } }) },
    'DELETE /api/pages/:id': freshId(make.page),
    'POST /api/pages/:id/restore': freshId(() => trashed('page')),
    'GET /api/pages': { call: () => ({ query: { notebookId: w.notebook } }) },
    'GET /api/notebooks': { call: () => ({ query: {} }) },
    'POST /api/pages/:pageId/snapshots/replace': {
      call: () => ({ body: { content: para('replaced') } }),
    },
    'POST /api/pages/:pageId/snapshots/:snapshotId/restore': {},
    'GET /api/notebooks/:id/shares': { call: () => ({ params: { id: w.personalNotebook } }) },
    'PUT /api/notebooks/:id/shares': {
      call: async () => ({
        params: { id: w.personalNotebook },
        body: { userId: (await make.member()).id, access: 'read' },
      }),
    },
    'DELETE /api/notebooks/:id/shares/:shareId': fresh(async () => ({
      id: w.personalNotebook,
      shareId: await make.share(),
    })),
    'DELETE /api/notebooks/:id/pending-shares/:pendingId': fresh(async () => ({
      id: w.personalNotebook,
      pendingId: await make.pending(),
    })),
    'POST /api/notebooks/:id/links': { call: () => ({ body: { access: 'read' } }) },
    'PATCH /api/links/:id': { call: () => ({ body: { showAuthors: true } }) },
    'DELETE /api/links/:id': fresh(async () => ({ id: (await make.link()).id })),
    'POST /api/links/resolve': { call: () => ({ body: { token: w.link.token } }) },
    'POST /api/links/join': { call: () => ({ body: { token: w.editLink } }) },
    'GET /api/links/:token/search': { call: () => ({ query: { q: 'hello' } }) },
    'GET /api/search': { call: () => ({ query: { q: 'hello' } }) },
    'GET /api/export/markdown': { call: () => ({ query: { scope: 'page', id: w.page } }) },
    'POST /api/export/pdf': {
      call: () => ({ body: { scope: 'page', id: w.page } }),
      alsoOk: [503],
    },
    'POST /api/media': { call: () => ({ fields: { id: uuid() } }) },
    'POST /api/sync/batch': {
      call: () => ({
        body: {
          ops: [
            { opId: uuid(), type: 'notebook.create', id: uuid(), name: 'Synced', position: pos() },
          ],
        },
      }),
    },
    'GET /api/sync/changes': { call: () => ({ query: { cursors: '{}' } }) },

    // ---- boards
    'POST /api/spaces/:id/boards': {
      call: () => ({ body: { id: uuid(), name: 'New', position: pos() } }),
    },
    'PATCH /api/boards/:id': { call: () => ({ body: { name: 'Renamed' } }) },
    'DELETE /api/boards/:id': freshId(make.board),
    'POST /api/boards/:id/restore': freshId(() => trashed('board')),
    'POST /api/boards/:id/duplicate': { call: () => ({ body: { id: uuid(), name: 'Copy' } }) },
    'POST /api/boards/:id/columns': {
      call: () => ({ body: { id: uuid(), name: 'New', position: pos() } }),
    },
    'PATCH /api/columns/:id': { call: () => ({ body: { name: 'Renamed' } }) },
    'DELETE /api/columns/:id': freshId(make.column, { body: {} }),
    'POST /api/spaces/:id/labels': {
      call: () => ({ body: { id: uuid(), name: `l${Date.now() % 1e6}`, color: '#123456' } }),
    },
    'PATCH /api/labels/:id': { call: () => ({ body: { description: 'Edited' } }) },
    'DELETE /api/labels/:id': freshId(make.label),
    'POST /api/boards/:id/tasks': {
      call: () => ({
        body: { id: uuid(), columnId: w.columns.todo, position: pos(), title: 'New' },
      }),
    },
    'PATCH /api/tasks/:id': { call: () => ({ body: { title: 'Renamed' } }) },
    'POST /api/tasks/:id/move': {
      call: () => ({ body: { columnId: w.columns.doing, position: pos() } }),
    },
    'DELETE /api/tasks/:id': freshId(make.task),
    'POST /api/tasks/:id/restore': freshId(make.trashedTask),
    'DELETE /api/tasks/:id/purge': freshId(make.trashedTask),
    'PUT /api/tasks/:id/assignees/:userId': {
      call: () => ({ params: { id: w.task2, userId: people.viewer.id } }),
    },
    'DELETE /api/tasks/:id/assignees/:userId': {
      call: () => ({ params: { id: w.task2, userId: people.viewer.id } }),
    },
    'PUT /api/tasks/:id/labels/:labelId': {
      call: () => ({ params: { id: w.task2, labelId: w.label } }),
    },
    'DELETE /api/tasks/:id/labels/:labelId': {
      call: () => ({ params: { id: w.task2, labelId: w.label } }),
    },
    'POST /api/tasks/:id/checklist': {
      call: () => ({ body: { id: uuid(), text: 'New', position: pos() } }),
    },
    'PATCH /api/tasks/:id/checklist/:itemId': { call: () => ({ body: { text: 'Edited' } }) },
    'DELETE /api/tasks/:id/checklist/:itemId': fresh(async () => ({
      id: w.task,
      itemId: await make.item(),
    })),
    'POST /api/tasks/:id/comments': { call: () => ({ body: { id: uuid(), content: 'New' } }) },
    'PATCH /api/comments/:id': { call: () => ({ body: { content: 'Edited' } }) },
    'DELETE /api/comments/:id': freshId(make.comment),
    'POST /api/tasks/:id/attachments': { call: () => ({ fields: { id: uuid() } }) },
    'DELETE /api/tasks/:id/attachments/:attachmentId': fresh(async () => ({
      id: w.task,
      attachmentId: await make.attachment(),
    })),

    // ---- calendar
    'GET /api/calendar': {
      call: () => ({ query: { from: '2026-12-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' } }),
    },
    'GET /api/calendar/export': { call: () => ({ query: {} }) },
    'POST /api/events': {
      call: () => ({
        body: {
          id: uuid(),
          spaceId: w.team.spaceId,
          title: 'New',
          kind: 'meeting',
          startAt: '2026-12-02T10:00:00.000Z',
          endAt: '2026-12-02T11:00:00.000Z',
        },
      }),
    },
    'PATCH /api/events/:id': { call: () => ({ body: { title: 'Renamed' } }) },
    'DELETE /api/events/:id': freshId(make.event),
    'POST /api/events/:id/duplicate': { call: () => ({ body: { id: uuid() } }) },
    'POST /api/events/:id/rsvp': freshId(make.event, { body: { status: 'accepted' } }),
    'POST /api/events/:id/attendees': {
      call: () => ({ body: { attendees: [{ kind: 'user', subjectId: people.viewer.id }] } }),
    },
    'DELETE /api/events/:id/attendees/:kind/:subjectId': fresh(async () => {
      const id = await make.event();
      await ok(
        await as(people.power).post(`/api/events/${id}/attendees`, {
          attendees: [{ kind: 'user', subjectId: people.viewer.id }],
        }),
        'attendee',
      );
      return { id, kind: 'user', subjectId: people.viewer.id };
    }),
    'PUT /api/events/:id/reminders': { call: () => ({ body: { minutes: [10] } }) },
    'PUT /api/me/calendar-settings': { call: () => ({ body: {} }) },

    // ---- feeds, followed calendars, import
    'DELETE /api/me/feeds/:id': fresh(async () => ({ id: (await make.feed()).id })),
    'POST /api/me/feeds/:id/rotate': fresh(async () => ({ id: (await make.feed()).id })),
    'PATCH /api/me/feeds/:id': { call: () => ({ body: { name: 'Renamed' } }) },
    'POST /api/me/external-calendars': { own: 'ics.test (it fetches the address)' },
    'PATCH /api/me/external-calendars/:id': { call: () => ({ body: { name: 'Renamed' } }) },
    'DELETE /api/me/external-calendars/:id': freshId(make.external),
    'POST /api/me/external-calendars/:id/refresh': freshId(make.external, {}),
    'GET /api/me/external-calendars/:id/events': {
      call: () => ({ query: { from: '2026-12-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' } }),
    },
    'POST /api/calendar/import': { own: 'ics.test (a calendar file to read)' },
    'GET /api/feeds/:file': {},

    // ---- notifications and push
    'POST /api/notifications/read': { call: () => ({ body: { all: true } }) },
    'PUT /api/notifications/quiet-hours': {
      call: () => ({
        body: {
          enabled: true,
          from: '22:00',
          to: '07:00',
          days: [1, 2, 3],
          timeZone: 'Europe/Lisbon',
        },
      }),
    },
    'GET /api/notification-settings/effective': {
      call: () => ({ query: { scopeKind: 'global' } }),
    },
    'PUT /api/notification-settings': {
      call: () => ({ body: { scopeKind: 'global', level: 'mentions' } }),
    },
    'POST /api/notification-settings/mute': {
      call: () => ({ body: { scopeKind: 'global', until: null } }),
    },
    'DELETE /api/notification-settings/:id': freshId(make.setting),
    'POST /api/push/subscribe': {
      call: () => ({
        body: {
          endpoint: `${PUSH_ORIGIN}/${uuid()}`,
          keys: {
            p256dh:
              'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
            auth: 'tBHItJI5svbpez7KI4CCXg',
          },
        },
      }),
    },
    'DELETE /api/push/subscribe': {
      call: () => ({ body: { endpoint: `${PUSH_ORIGIN}/nothing` } }),
    },
    'DELETE /api/push/devices/:id': freshId(make.device),
    'POST /api/mail/unsubscribe': {
      own: 'notifications.test (a signed link; a wrong one is checked below)',
    },

    // ---- releases
    'PUT /api/admin/releases/files/:name': {},
    'POST /api/admin/releases': {},
  };
}

// ------------------------------------------------------------------ running a call

interface Answer {
  status: number;
  body: unknown;
  ms: number;
}

async function send(route: RouteInfo, call: Call, who: Account | null): Promise<Answer> {
  let path = route.path;
  for (const [k, v] of Object.entries(call.params))
    path = path.replace(`:${k}`, encodeURIComponent(v));
  const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  let req = t.http[method](path).set(bearer(who));
  for (const [k, v] of Object.entries(call.headers ?? {})) req = req.set(k, v);
  if (call.query) req = req.query(call.query);
  const started = performance.now();
  if (route.multipart) {
    for (const [k, v] of Object.entries(call.fields ?? {})) req = req.field(k, v);
    req = req.attach('file', await png(), 'upload.png');
  } else if (call.body !== undefined) req = req.send(call.body as object);
  const res = await req;
  return { status: res.status, body: res.body, ms: performance.now() - started };
}

async function callFor(route: RouteInfo, c: Case, who: Persona): Promise<Call> {
  const given = (await c.call?.(who)) ?? {};
  const names = paramNames(route.path);
  const segments = route.path.split('/');
  const params: Record<string, string> = {};
  for (const name of names) {
    if (given.params?.[name] !== undefined) continue;
    const at = segments.findIndex((s) => s.startsWith(`:${name}`));
    params[name] = defaultParam(route, name, segments[at - 1] ?? '');
  }
  return {
    params: { ...params, ...given.params },
    body: 'body' in given ? given.body : route.body ? sample(route.body) : undefined,
    query:
      given.query ?? (route.query ? (sample(route.query) as Record<string, unknown>) : undefined),
    fields:
      given.fields ??
      (route.multipart && route.body ? (sample(route.body) as Record<string, string>) : undefined),
    headers: given.headers,
  };
}

const describeAnswer = (a: Answer) => `${a.status} ${JSON.stringify(a.body).slice(0, 160)}`;

/** Writes a readable report next to the test data (`apps/server/.test-data/<name>.txt`): the full list, not the truncated diff. */
function report(name: string, lines: string[]): void {
  const dir = process.env.DATA_DIR!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.txt`), `${lines.join('\n')}\n`);
}

// ------------------------------------------------------------------ setup

beforeAll(async () => {
  const lk = await startFakeLiveKit();
  const vapid = webpush.generateVAPIDKeys();
  const env: Record<string, string> = {
    ADMIN_EMAILS: ADMIN_EMAIL,
    RELEASE_TOKEN,
    LIVEKIT_URL: `ws://${lk}`,
    LIVEKIT_API_URL: `http://${lk}`,
    LIVEKIT_API_KEY: LK_KEY,
    LIVEKIT_API_SECRET: LK_SECRET,
    VOICE_CHECK_SECONDS: '0',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:admin@example.com',
    PUSH_EXTRA_ENDPOINTS: PUSH_ORIGIN,
    COLLAB_DEBOUNCE_MS: '50',
    COLLAB_MAX_DEBOUNCE_MS: '200',
  };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t = await createTestApp();
  baseUrl = await listen(t);
  await t.prisma.team.deleteMany();
  await t.prisma.quotaOverride.deleteMany();
  await t.prisma.user.deleteMany();
  people.admin = await signup(t, true, ADMIN_EMAIL);
  for (const p of ['owner', 'power', 'viewer', 'blind', 'banned', 'removed', 'outsider'] as const)
    people[p] = await signup(t, true);
  people.unverified = await signup(t, false);
  await buildWorld();
}, 120_000);

afterAll(async () => {
  closeSockets();
  await t?.close();
  await new Promise<void>((r) => fakeLiveKit?.close(() => r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ------------------------------------------------------------------ the tests

describe('authorization: declarations', () => {
  it('every route declares who may call it, with real permission names', () => {
    const routes = listRoutes(t.app);
    expect(routes.length).toBeGreaterThan(200);
    const missing = routes
      .filter((r) => !r.rule)
      .map((r) => `${r.key} (${r.controller}.${r.handler})`);
    expect(missing, 'routes without @Authz').toEqual([]);
    const wrong: string[] = [];
    for (const r of routes) {
      const rule = r.rule!;
      if (!SCOPES.includes(rule.scope)) wrong.push(`${r.key}: scope ${rule.scope}`);
      for (const n of [...(rule.needs ?? []), ...(rule.anyOf ?? [])])
        if (!PERMISSION_NAMES.includes(n as PermissionName)) wrong.push(`${r.key}: ${n}`);
      if (
        (rule.needs?.length || rule.author || rule.ownerOnly) &&
        !TEAM_SCOPES.includes(rule.scope)
      )
        wrong.push(`${r.key}: permissions outside a team scope`);
    }
    expect(wrong).toEqual([]);
  });

  it('every socket event and every room a client may join is declared', () => {
    expect(Object.keys(AUTHZ_SOCKET_EVENTS).sort()).toEqual([...CLIENT_EVENTS].sort());
    expect(Object.keys(AUTHZ_ROOMS).sort()).toEqual([...JOINABLE_ROOM_KINDS].sort());
  });

  it('the server listens to the declared socket events and nothing else', async () => {
    const socket = await connect(baseUrl, people.viewer);
    await new Promise((r) => setTimeout(r, 100));
    const server = [
      ...t.app
        .get((await import('../src/realtime/realtime.server.js')).RealtimeServer)
        .io.of('/')
        .sockets.values(),
    ].find((s) => (s.data as { userId?: string }).userId === people.viewer.id)!;
    const listened = server
      .eventNames()
      .filter(
        (e) => typeof e === 'string' && !['disconnect', 'disconnecting', 'error'].includes(e),
      );
    expect(listened.sort()).toEqual([...CLIENT_EVENTS].sort());
    socket.disconnect();
  });
});

describe('authorization: every route, every persona', () => {
  it('answers what the declaration says', async () => {
    const routes = listRoutes(t.app);
    const table = cases();
    const failures: string[] = [];
    const tolerated: string[] = [];
    let calls = 0;
    for (const route of routes) {
      const rule = route.rule!;
      const c = table[route.key] ?? {};
      if (c.own) continue;
      const want = (who: Persona): Outcome => c.expect?.[who] ?? expected(rule, who);
      // refused people first: a wrong "allowed" there must not consume the fixture of the people allowed after them
      const order = [...PERSONAS].sort(
        (a, b) => Number(want(a) === 'ok') - Number(want(b) === 'ok'),
      );
      let refusedCall: Call | undefined;
      for (const who of order) {
        let call: Call;
        try {
          call =
            c.fresh && want(who) !== 'ok' && refusedCall
              ? { ...refusedCall }
              : await callFor(route, c, who);
        } catch (e) {
          failures.push(
            `${route.key}: could not prepare the call (${e instanceof Error ? e.message : e})`,
          );
          break;
        }
        if (want(who) !== 'ok') refusedCall ??= call;
        let account = accountOf(who);
        let headers = call.headers;
        if (rule.scope === 'release' && who === 'owner')
          headers = { ...headers, Authorization: `Bearer ${RELEASE_TOKEN}` };
        if (rule.scope === 'release' && who === 'owner') account = null;
        const answer = await send(route, { ...call, headers }, account);
        calls++;
        if (rule.scope === 'release' && who === 'owner') {
          if (answer.status === 401 || answer.status === 404 || answer.status >= 500)
            failures.push(`${route.key} with the release token: ${describeAnswer(answer)}`);
          continue;
        }
        const wanted = want(who);
        if (wanted === 'ok') {
          const allowed = answer.status < 400 || (c.alsoOk ?? []).includes(answer.status);
          if (!allowed)
            failures.push(`${route.key} as ${who}: wanted ok, got ${describeAnswer(answer)}`);
          else if (answer.status >= 400) tolerated.push(`${route.key} as ${who}: ${answer.status}`);
        } else if (answer.status !== wanted)
          failures.push(`${route.key} as ${who}: wanted ${wanted}, got ${describeAnswer(answer)}`);
        if (answer.status >= 500)
          failures.push(`${route.key} as ${who}: server error ${describeAnswer(answer)}`);
      }
    }
    report('authz-routes', [
      `${routes.length} routes, ${calls} calls`,
      '',
      'FAILURES',
      ...failures,
      '',
      'ALLOWED WITH A NON-2XX ANSWER (alsoOk)',
      ...tolerated,
    ]);
    expect(
      failures.length,
      `${failures.length} failures:\n${failures.slice(0, 40).join('\n')}`,
    ).toBe(0);
  }, 900_000);
});

describe('authorization: routes with a story of their own', () => {
  const PASSWORD = 'correct horse battery';

  it('leaving: a member may, the owner must hand the team over first, anybody else gets 404', async () => {
    const leaver = await make.member();
    expect((await t.http.delete(`/api/teams/${w.team.id}/members/me`)).status).toBe(401);
    for (const p of ['outsider', 'banned', 'removed', 'admin', 'unverified'] as const)
      expect((await as(people[p]).del(`/api/teams/${w.team.id}/members/me`)).status, p).toBe(404);
    expect((await as(leaver).del(`/api/teams/${w.team.id}/members/me`)).status).toBe(204);
    expect(
      await t.prisma.teamMember.count({ where: { teamId: w.team.id, userId: leaver.id } }),
    ).toBe(0);
    const owner = await as(people.owner).del(`/api/teams/${w.team.id}/members/me`);
    expect([403, 409, 422], JSON.stringify(owner.body)).toContain(owner.status);
  });

  it('handing a team over: only its owner, with their password, to a member', async () => {
    const teamId = await make.team();
    const heir = await signup(t);
    await t.prisma.teamMember.create({ data: { teamId, userId: heir.id } });
    await t.prisma.teamMember.create({ data: { teamId, userId: people.viewer.id } });
    const path = `/api/teams/${teamId}/transfer-ownership`;
    expect((await t.http.post(path).send({ userId: heir.id, password: PASSWORD })).status).toBe(
      401,
    );
    expect(
      (await as(people.outsider).post(path, { userId: heir.id, password: PASSWORD })).status,
    ).toBe(404);
    expect(
      (await as(people.admin).post(path, { userId: heir.id, password: PASSWORD })).status,
    ).toBe(404);
    expect(
      (await as(people.viewer).post(path, { userId: heir.id, password: PASSWORD })).status,
    ).toBe(403);
    expect(
      (await as(people.owner).post(path, { userId: heir.id, password: 'not the password' })).status,
    ).not.toBe(204);
    expect(
      (await as(people.owner).post(path, { userId: people.outsider.id, password: PASSWORD }))
        .status,
    ).not.toBe(204);
    expect(
      (await as(people.owner).post(path, { userId: heir.id, password: PASSWORD })).status,
    ).toBe(204);
    expect((await t.prisma.team.findUniqueOrThrow({ where: { id: teamId } })).ownerId).toBe(
      heir.id,
    );
  });

  it("joining a listed team asks; a banned person, an unverified one and a member cannot; withdrawing is one's own", async () => {
    const path = `/api/teams/${w.team.id}/join`;
    expect((await t.http.post(path).send({})).status).toBe(401);
    expect((await as(people.unverified).post(path, {})).status).toBe(403);
    const banned = await as(people.banned).post(path, {});
    expect([403, 404], JSON.stringify(banned.body)).toContain(banned.status);
    const asker = await signup(t);
    const asked = await as(asker).post(path, { message: 'hi' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body.status).toBe('requested');
    expect(
      await t.prisma.teamMember.count({ where: { teamId: w.team.id, userId: asker.id } }),
    ).toBe(0);
    // an unlisted team is not there at all
    const hidden = await make.team();
    expect((await as(asker).post(`/api/teams/${hidden}/join`, {})).status).toBe(404);
    // withdrawing: only one's own request
    const other = await signup(t);
    const none = await as(other).del(`/api/teams/${w.team.id}/join-request`);
    expect([204, 404]).toContain(none.status);
    expect(
      await t.prisma.joinRequest.count({
        where: { teamId: w.team.id, userId: asker.id, status: 'pending' },
      }),
    ).toBe(1);
    expect((await as(asker).del(`/api/teams/${w.team.id}/join-request`)).status).toBe(204);
    expect(
      await t.prisma.joinRequest.count({
        where: { teamId: w.team.id, userId: asker.id, status: 'pending' },
      }),
    ).toBe(0);
  });

  it('accepting an invite: an email invite is for its address only, a link for any verified person who is not banned', async () => {
    const email = `invited${Date.now()}@example.com`;
    await ok(await as(people.owner).post(`/api/teams/${w.team.id}/invites`, { email }), 'invite');
    const token = t.mail.last('invite', email)!.token;
    expect((await t.http.post('/api/invites/accept').send({ token })).status).toBe(401);
    // holding the token of somebody else's invite: told it is for another address (to sign in with that one), and nothing happens
    for (const p of ['outsider', 'viewer', 'admin'] as const) {
      const res = await as(people[p]).post('/api/invites/accept', { token });
      expect(res.status, p).toBe(403);
      expect(res.body.message).toBe('invite_other_address');
    }
    const unknown = await as(people.outsider).post('/api/invites/accept', {
      token: `${token.slice(0, -4)}AAAA`,
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toBe('invalid_invite');
    expect(
      await t.prisma.teamMember.count({ where: { teamId: w.team.id, userId: people.outsider.id } }),
    ).toBe(0);
    const invited = await signup(t, true, email);
    expect((await as(invited).post('/api/invites/accept', { token })).status).toBe(200);

    const link = await ok(
      await as(people.owner).post(`/api/teams/${w.team.id}/invites`, { link: true }),
      'link invite',
    );
    const linkToken = String(link.url).split('/').pop()!;
    expect(
      (await as(people.unverified).post('/api/invites/accept', { token: linkToken })).status,
    ).toBe(403);
    const banned = await as(people.banned).post('/api/invites/accept', { token: linkToken });
    expect([403, 404], JSON.stringify(banned.body)).toContain(banned.status);
    expect(
      await t.prisma.teamMember.count({ where: { teamId: w.team.id, userId: people.banned.id } }),
    ).toBe(0);
    const newcomer = await signup(t);
    expect((await as(newcomer).post('/api/invites/accept', { token: linkToken })).status).toBe(200);
    expect(
      await t.prisma.teamMember.count({ where: { teamId: w.team.id, userId: newcomer.id } }),
    ).toBe(1);
  });

  it("nobody can end somebody else's session", async () => {
    const sessionId = await make.session();
    for (const p of ['outsider', 'viewer', 'owner', 'admin'] as const)
      await as(people[p]).del(`/api/me/sessions/${sessionId}`);
    expect(
      await t.prisma.refreshToken.count({
        where: { userId: people.power.id, familyId: sessionId, revokedAt: null },
      }),
    ).toBe(1);
    expect((await as(people.power).del(`/api/me/sessions/${sessionId}`)).status).toBe(204);
    expect(
      await t.prisma.refreshToken.count({
        where: { userId: people.power.id, familyId: sessionId, revokedAt: null },
      }),
    ).toBe(0);
  });

  it('a wrong secret answers like a missing one, and never with a server error', async () => {
    const wrong = () => `${uuid().replace(/-/g, '')}${uuid().replace(/-/g, '')}`.slice(0, 43);
    const probes: [string, () => Promise<{ status: number; body: unknown }>][] = [
      ['feed', () => t.http.get(`/api/feeds/${wrong()}.ics`)],
      ['link resolve', () => t.http.post('/api/links/resolve').send({ token: wrong() })],
      ['link page', () => t.http.get(`/api/links/${wrong()}/pages/${w.page}`)],
      ['link media', () => t.http.get(`/api/links/${wrong()}/media/${w.linkMedia}`)],
      ['link search', () => t.http.get(`/api/links/${wrong()}/search`).query({ q: 'hello' })],
      ['invite preview', () => t.http.get('/api/invites/preview').query({ token: wrong() })],
      ['verify email', () => t.http.post('/api/auth/verify-email').send({ token: wrong() })],
      [
        'reset password',
        () =>
          t.http
            .post('/api/auth/reset-password')
            .send({ token: wrong(), password: 'a long new password' }),
      ],
      ['mail action', () => t.http.post('/api/mail/unsubscribe').send({ token: wrong() })],
      [
        'release',
        () => t.http.post('/api/admin/releases').set('Authorization', `Bearer ${wrong()}`).send({}),
      ],
      [
        'webhook',
        () =>
          t.http
            .post('/api/voice/webhook')
            .set('Content-Type', 'application/webhook+json')
            .set('Authorization', wrong())
            .send('{}'),
      ],
    ];
    for (const [what, probe] of probes) {
      const a = await probe();
      const b = await probe();
      expect(a.status, `${what}: ${JSON.stringify(a.body)}`).toBeLessThan(500);
      expect([400, 401, 404, 410], `${what}: ${a.status} ${JSON.stringify(a.body)}`).toContain(
        a.status,
      );
      expect({ status: b.status, body: b.body }, what).toEqual({ status: a.status, body: a.body });
    }
  });
});

describe('authorization: something hidden looks like nothing', () => {
  it('a real id the person may not see answers like an id that does not exist (status, body and time)', async () => {
    const routes = listRoutes(t.app);
    const table = cases();
    const failures: string[] = [];
    const timings: string[] = [];
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    for (const route of routes) {
      const rule = route.rule!;
      const c = table[route.key] ?? {};
      if (c.own || !paramNames(route.path).length) continue;
      // the person who must be told "not found": an outsider, or a member without the VIEW_* bit of the place
      const who: Persona | undefined = (['outsider', 'blind'] as const).find(
        (p) => (c.expect?.[p] ?? expected(rule, p)) === 404,
      );
      if (!who) continue;
      const call = await callFor(route, c, who);
      // every id in the path, the body and the query replaced by one that does not exist
      const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const swap = (v: unknown): unknown =>
        typeof v === 'string'
          ? ID.test(v)
            ? v[14] === '7'
              ? uuidv7()
              : uuid()
            : v
          : Array.isArray(v)
            ? v.map(swap)
            : v && typeof v === 'object'
              ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]))
              : v;
      const missingCall = (): Call => ({
        ...call,
        params: swap(call.params) as Record<string, string>,
        body: swap(call.body),
        query: swap(call.query) as Record<string, unknown> | undefined,
      });
      if (
        JSON.stringify(swap(call.params)) === JSON.stringify(call.params) &&
        !JSON.stringify(call.body ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}/)
      )
        continue;
      const real: Answer[] = [];
      const none: Answer[] = [];
      for (let i = 0; i < 3; i++) {
        real.push(await send(route, call, accountOf(who)));
        none.push(await send(route, missingCall(), accountOf(who)));
      }
      const [a, b] = [real[0]!, none[0]!];
      if (a.status !== b.status || JSON.stringify(a.body) !== JSON.stringify(b.body))
        failures.push(
          `${route.key} as ${who}: hidden ${describeAnswer(a)} / missing ${describeAnswer(b)}`,
        );
      const gap = median(real.map((r) => r.ms)) - median(none.map((r) => r.ms));
      timings.push(`${gap.toFixed(1).padStart(7)} ms  ${route.key}`);
      if (Math.abs(gap) > 75)
        failures.push(`${route.key} as ${who}: hidden and missing differ by ${gap.toFixed(0)} ms`);
    }
    report('authz-hidden', [
      'FAILURES',
      ...failures,
      '',
      'MEDIAN TIME OF HIDDEN MINUS MISSING',
      ...timings.sort(),
    ]);
    expect(failures.length, failures.slice(0, 30).join('\n')).toBe(0);
    expect(timings.length).toBeGreaterThan(100);
  }, 600_000);
});

describe('authorization: across teams', () => {
  /** A second team the owner also owns (so permissions never decide): what is of team B must never be reached through team A. */
  it('an id of another team, board, page or notebook under a route of this one finds nothing and changes nothing', async () => {
    const o = as(people.owner);
    const teamB = await make.team();
    const rowB = await t.prisma.team.findUniqueOrThrow({ where: { id: teamB } });
    // what team B holds
    const boardB = uuid();
    await ok(
      await o.post(`/api/spaces/${rowB.spaceId}/boards`, {
        id: boardB,
        name: 'B board',
        position: pos(),
      }),
      'board B',
    );
    const colsB = (await ok(await o.get(`/api/boards/${boardB}`), 'board B detail')).columns as {
      id: string;
    }[];
    const taskB = uuid();
    await ok(
      await o.post(`/api/boards/${boardB}/tasks`, {
        id: taskB,
        columnId: colsB[0]!.id,
        position: pos(),
        title: 'B task',
      }),
      'task B',
    );
    const itemB = uuid();
    await ok(
      await o.post(`/api/tasks/${taskB}/checklist`, { id: itemB, text: 'B item', position: pos() }),
      'item B',
    );
    const attB = (
      await ok(
        await t.http
          .post(`/api/tasks/${taskB}/attachments`)
          .set(people.owner.auth)
          .field('id', uuid())
          .attach('file', await png(), 'b.png'),
        'attachment B',
      )
    ).id as string;
    const labelB = uuid();
    await ok(
      await o.post(`/api/spaces/${rowB.spaceId}/labels`, {
        id: labelB,
        name: 'B label',
        color: '#123456',
      }),
      'label B',
    );
    const roleB = (
      await ok(await o.post(`/api/teams/${teamB}/roles`, { name: 'B role' }), 'role B')
    ).id as string;
    const channelB = (
      await ok(
        await o.post(`/api/spaces/${rowB.spaceId}/channels`, { name: 'b-general' }),
        'channel B',
      )
    ).id as string;
    const messageB = (
      await ok(
        await o.post(`/api/channels/${channelB}/messages`, { id: uuidv7(), content: 'B message' }),
        'message B',
      )
    ).id as string;
    const nbB = uuid();
    await ok(
      await o.post('/api/notebooks', {
        id: nbB,
        spaceId: rowB.spaceId,
        name: 'B notes',
        position: pos(),
      }),
      'notebook B',
    );
    const catB = (await ok(await o.get(`/api/notebooks/${nbB}/tree`), 'tree B')).categories[0]
      .id as string;
    const pageB = uuid();
    await ok(
      await o.post('/api/pages', { id: pageB, categoryId: catB, title: 'B page', position: pos() }),
      'page B',
    );
    await ok(
      await o.post(`/api/pages/${pageB}/snapshots/replace`, { content: para('first') }),
      'B content',
    );
    await ok(
      await o.post(`/api/pages/${pageB}/snapshots/replace`, { content: para('second') }),
      'B content again',
    );
    const snapB = (await t.prisma.pageYSnapshot.findFirstOrThrow({ where: { pageId: pageB } })).id;
    const requester = await signup(t);
    await t.prisma.team.update({
      where: { id: teamB },
      data: { isPublic: true, joinPolicy: 'request' },
    });
    await ok(await as(requester).post(`/api/teams/${teamB}/join`, {}), 'request B');
    const requestB = (
      await t.prisma.joinRequest.findFirstOrThrow({
        where: { teamId: teamB, userId: requester.id },
      })
    ).id;
    const memberB = await signup(t);
    await t.prisma.teamMember.create({ data: { teamId: teamB, userId: memberB.id } });

    const cases: [string, () => Promise<{ status: number; body: unknown }>][] = [
      [
        'a checklist item of another task (edit)',
        () => o.patch(`/api/tasks/${w.task}/checklist/${itemB}`, { text: 'hijacked' }),
      ],
      [
        'a checklist item of another task (remove)',
        () => o.del(`/api/tasks/${w.task}/checklist/${itemB}`),
      ],
      ['a file of another task', () => o.del(`/api/tasks/${w.task}/attachments/${attB}`)],
      ['a label of another team on a task', () => o.put(`/api/tasks/${w.task}/labels/${labelB}`)],
      [
        'a column of another board for a new task',
        () =>
          o.post(`/api/boards/${w.board}/tasks`, {
            id: uuid(),
            columnId: colsB[0]!.id,
            position: pos(),
            title: 'into B',
          }),
      ],
      [
        'a column of another board for a move',
        () => o.post(`/api/tasks/${w.task}/move`, { columnId: colsB[0]!.id, position: pos() }),
      ],
      [
        'a snapshot of another page (preview)',
        () => o.get(`/api/pages/${w.page}/snapshots/${snapB}`),
      ],
      [
        'a snapshot of another page (restore)',
        () => o.post(`/api/pages/${w.page}/snapshots/${snapB}/restore`, {}),
      ],
      [
        'a join request of another team (approve)',
        () => o.post(`/api/teams/${w.team.id}/join-requests/${requestB}/approve`, {}),
      ],
      [
        'a role of another team given to a member here',
        () => o.put(`/api/teams/${w.team.id}/members/${w.target.id}/roles/${roleB}`),
      ],
      [
        'a member of another team given a role here',
        () => o.put(`/api/teams/${w.team.id}/members/${memberB.id}/roles/${w.lowRole}`),
      ],
      [
        'a role of another team in an overwrite here',
        () =>
          o.put('/api/overwrites', {
            targetKind: 'project',
            targetId: w.project.id,
            subjectKind: 'role',
            subjectId: roleB,
            allow: permissionsToString(P.VIEW_CHANNEL),
          }),
      ],
      [
        'a message of another channel marked read',
        () => o.put(`/api/channels/${w.channel}/read`, { messageId: messageB }),
      ],
      [
        'a reply to a message of another channel',
        () =>
          o.post(`/api/channels/${w.channel}/messages`, {
            id: uuidv7(),
            content: 'reply',
            replyToId: messageB,
          }),
      ],
      [
        'a role of another team invited to a meeting',
        () =>
          o.post(`/api/events/${w.event}/attendees`, {
            attendees: [{ kind: 'role', subjectId: roleB }],
          }),
      ],
    ];
    const failures: string[] = [];
    for (const [what, call] of cases) {
      const res = await call();
      // a no-op removal may answer 2xx (it is idempotent); everything else must be a refusal
      const refusal =
        res.status === 404 || res.status === 422 || res.status === 400 || res.status === 409;
      const harmlessNoop = what.includes('(remove)') || what.startsWith('a file of another task');
      if (!refusal && !(harmlessNoop && res.status < 300))
        failures.push(`${what}: ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
    }
    // nothing of team B changed, and nothing of B appeared in A
    expect((await t.prisma.checklistItem.findUnique({ where: { id: itemB } }))?.text).toBe(
      'B item',
    );
    expect(await t.prisma.taskAttachment.count({ where: { id: attB } })).toBe(1);
    expect(await t.prisma.taskLabel.count({ where: { taskId: w.task, labelId: labelB } })).toBe(0);
    expect(await t.prisma.task.count({ where: { boardId: w.board, columnId: colsB[0]!.id } })).toBe(
      0,
    );
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: w.task } })).boardId).toBe(
      w.board,
    );
    expect((await t.prisma.joinRequest.findUniqueOrThrow({ where: { id: requestB } })).status).toBe(
      'pending',
    );
    expect(await t.prisma.memberRole.count({ where: { userId: w.target.id, roleId: roleB } })).toBe(
      0,
    );
    expect(
      await t.prisma.memberRole.count({ where: { userId: memberB.id, roleId: w.lowRole } }),
    ).toBe(0);
    expect(await t.prisma.overwrite.count({ where: { subjectId: roleB } })).toBe(0);
    expect(
      await t.prisma.eventAttendee.count({ where: { eventId: w.event, subjectId: roleB } }),
    ).toBe(0);
    expect(
      await t.prisma.teamMember.count({
        where: { teamId: w.team.id, userId: { in: [memberB.id, requester.id] } },
      }),
    ).toBe(0);
    expect(failures).toEqual([]);
  });
});

describe('authorization: sockets and co-editing', () => {
  it('a room is joined by exactly the people its rule allows', async () => {
    const rooms: [keyof typeof AUTHZ_ROOMS, string][] = [
      ['space', w.team.spaceId],
      ['channel', w.channel],
      ['thread', w.thread],
      ['board', w.board],
    ];
    expect((await connect(baseUrl, null).catch((e: Error) => e.message)) as string).toBe(
      'unauthorized',
    );
    const failures: string[] = [];
    for (const who of PERSONAS.filter((p) => p !== 'anon')) {
      const socket = await connect(baseUrl, people[who]);
      for (const [kind, id] of rooms) {
        const want = expected(AUTHZ_ROOMS[kind], who) === 'ok';
        const got = (await ack(socket, 'room:join', { kind, id })).ok;
        if (got !== want) failures.push(`${kind} as ${who}: wanted ${want}, got ${got}`);
        await ack(socket, 'room:leave', { kind, id });
      }
      // the room of a conversation: its two people only
      const dm = (await ack(socket, 'room:join', { kind: 'channel', id: w.dm.channelId })).ok;
      if (dm !== DM_PEOPLE.includes(who)) failures.push(`dm as ${who}: got ${dm}`);
      socket.disconnect();
    }
    expect(failures).toEqual([]);
  });

  it('a page opens for whoever may see its notebook, read-only without EDIT_PAGES', async () => {
    const url = `${baseUrl.replace(/^http/, 'ws')}${COLLAB_PATH}`;
    const open = (token: string) =>
      new Promise<'refused' | 'read-write' | 'readonly'>((resolve) => {
        let provider: HocuspocusProvider;
        const done = (v: 'refused' | 'read-write' | 'readonly') => {
          provider.destroy();
          resolve(v);
        };
        const timer = setTimeout(() => done('refused'), 5000);
        provider = new HocuspocusProvider({
          url,
          name: w.page,
          document: new Y.Doc(),
          token,
          WebSocketPolyfill: WebSocket as never,
          onAuthenticationFailed: () => (clearTimeout(timer), done('refused')),
          onSynced: () => (
            clearTimeout(timer),
            done(provider.authorizedScope === 'readonly' ? 'readonly' : 'read-write')
          ),
        });
      });
    const want: Record<Persona, string> = {
      anon: 'refused',
      unverified: 'refused',
      outsider: 'refused',
      banned: 'refused',
      removed: 'refused',
      admin: 'refused',
      blind: 'refused',
      viewer: 'readonly',
      power: 'read-write',
      owner: 'read-write',
    };
    for (const who of PERSONAS)
      expect(await open(who === 'anon' ? '' : people[who].token), who).toBe(want[who]);
  });
});

describe('mass assignment', () => {
  /** Body fields that name a person, an owner or a place: each is a target the route checks, never who is acting. Adding one is a review. */
  const REVIEWED_FIELDS = new Set([
    'POST /api/admin/teams ownerEmail',
    'POST /api/teams/:id/roles permissions',
    'POST /api/projects/:id/roles permissions',
    'PATCH /api/roles/:id permissions',
    'POST /api/projects/:id/members userId',
    'POST /api/teams/:id/transfer-ownership userId',
    'POST /api/dms userId',
    'PUT /api/notebooks/:id/shares userId',
    'POST /api/notebooks spaceId',
    'POST /api/notebooks/:id/move spaceId',
    'POST /api/events spaceId',
    'POST /api/events/:id/duplicate spaceId',
    'PUT /api/overwrites subjectId',
    'POST /api/media spaceId',
    'POST /api/teams/:id/invites projectId',
    'POST /api/tasks/:id/move boardId',
    'PUT /api/notification-settings scopeId',
    'POST /api/notification-settings/mute scopeId',
    'POST /api/calendar/import spaceId',
  ]);
  const SENSITIVE =
    /^(userId|ownerId|ownerEmail|authorId|createdBy|actorId|spaceId|teamId|projectId|boardId|scopeId|subjectId|permissions|isAdmin|emailVerifiedAt|role)$/;

  it('every JSON body and query rejects a field it does not know', async () => {
    const failures: string[] = [];
    let checked = 0;
    const table = cases();
    for (const route of listRoutes(t.app)) {
      const rule = route.rule!;
      if (rule.scope === 'release' || rule.scope === 'webhook') continue;
      const c = table[route.key] ?? {};
      // a person allowed through (or anybody, for public routes), so the answer is the validation's
      const who: Persona | undefined = PERSONAS.find(
        (p) => (c.expect?.[p] ?? expected(rule, p)) === 'ok',
      );
      if (!who) continue;
      const call = await callFor(route, c, who).catch(() => null);
      if (!call) continue;
      if (
        route.body &&
        !route.multipart &&
        call.body &&
        typeof call.body === 'object' &&
        !Array.isArray(call.body)
      ) {
        const res = await send(
          route,
          { ...call, body: { ...(call.body as object), unexpectedField: true } },
          accountOf(who),
        );
        checked++;
        if (res.status !== 400) failures.push(`${route.key} body: ${describeAnswer(res)}`);
      }
      if (route.query) {
        const res = await send(
          route,
          { ...call, query: { ...(call.query ?? {}), unexpectedParam: '1' } },
          accountOf(who),
        );
        checked++;
        if (res.status !== 400) failures.push(`${route.key} query: ${describeAnswer(res)}`);
      }
    }
    report('authz-mass-assignment', ['FAILURES', ...failures]);
    expect(checked).toBeGreaterThan(100);
    expect(failures.length, failures.slice(0, 30).join('\n')).toBe(0);
  }, 300_000);

  it('a field that names a person or a place in a body is one the route checks (the list is reviewed)', () => {
    const found = new Set<string>();
    for (const route of listRoutes(t.app)) {
      if (!route.body) continue;
      const js = z.toJSONSchema(route.body, { io: 'input', unrepresentable: 'any' }) as {
        properties?: Record<string, unknown>;
      };
      for (const key of Object.keys(js.properties ?? {}))
        if (SENSITIVE.test(key)) found.add(`${route.key} ${key}`);
    }
    expect([...found].sort()).toEqual([...REVIEWED_FIELDS].sort());
  });
});
