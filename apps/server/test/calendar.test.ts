import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALENDAR_EVENTS,
  Permission,
  permissionsToString,
  type CalendarDto,
  type EventDetailDto,
  type EventDto,
  type SyncChangesDto,
} from '@os-planner/shared';
import { MUTED_FOREVER, NOTIFY_EVENTS } from '@os-planner/shared/chat';
import { RemindersService } from '../src/calendar/reminders.service.js';
import { PushService } from '../src/notifications/push.service.js';
import { createTestApp, type TestApp } from './app.js';
import { personalSpaceId, signup, usedBytes, uuid, type Account } from './helpers.js';
import { ack, closeSockets, collect, connect, listen, sleep } from './sockets.js';

const P = Permission;
const ADMIN_EMAIL = `calendar-admin${Date.now()}@example.com`;
const MIN = 60_000;
const HOUR = 3_600_000;

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
afterEach(() => {
  closeSockets();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ helpers

interface Team {
  id: string;
  spaceId: string;
}

async function newTeam(members: Account[] = [member, other]): Promise<Team> {
  const res = await t.http
    .post('/api/admin/teams')
    .set(admin.auth)
    .send({ name: 'Planners', ownerEmail: owner.email });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const m of members)
    await t.prisma.teamMember.create({ data: { teamId: res.body.id, userId: m.id } });
  const row = await t.prisma.team.findUniqueOrThrow({ where: { id: res.body.id } });
  return { id: row.id, spaceId: row.spaceId };
}

async function newRole(team: Team, bits: bigint = 0n): Promise<string> {
  const res = await t.http
    .post(`/api/teams/${team.id}/roles`)
    .set(owner.auth)
    .send({
      name: `role${Math.random().toString(36).slice(2, 8)}`,
      permissions: permissionsToString(bits),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}
const assign = (team: Team, who: Account, roleId: string) =>
  t.http.put(`/api/teams/${team.id}/members/${who.id}/roles/${roleId}`).set(owner.auth);
const unassign = (team: Team, who: Account, roleId: string) =>
  t.http.delete(`/api/teams/${team.id}/members/${who.id}/roles/${roleId}`).set(owner.auth);
async function giveRole(team: Team, who: Account, bits: bigint): Promise<string> {
  const id = await newRole(team, bits);
  expect((await assign(team, who, id)).status).toBe(204);
  return id;
}

const at = (minutesFromNow: number): string =>
  new Date(Math.floor((Date.now() + minutesFromNow * MIN) / MIN) * MIN).toISOString();

const eventRes = (who: Account, spaceId: string, body: object = {}) =>
  t.http
    .post('/api/events')
    .set(who.auth)
    .send({
      id: uuid(),
      spaceId,
      title: 'Sync',
      startAt: '2027-03-15T09:00:00.000Z',
      endAt: '2027-03-15T10:00:00.000Z',
      timezone: 'Europe/Lisbon',
      ...body,
    });
async function newEvent(who: Account, spaceId: string, body: object = {}): Promise<EventDto> {
  const res = await eventRes(who, spaceId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as EventDto;
}
const detail = async (who: Account, id: string): Promise<EventDetailDto> => {
  const res = await t.http.get(`/api/events/${id}`).set(who.auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as EventDetailDto;
};
const patchEvent = (who: Account, id: string, body: object) =>
  t.http.patch(`/api/events/${id}`).set(who.auth).send(body);
const cancel = (who: Account, id: string, query: object = {}) =>
  t.http.delete(`/api/events/${id}`).set(who.auth).query(query);
const rsvp = (who: Account, id: string, status: string, extra: object = {}) =>
  t.http
    .post(`/api/events/${id}/rsvp`)
    .set(who.auth)
    .send({ status, ...extra });
const calendar = async (
  who: Account,
  from: string,
  to: string,
  query: object = {},
): Promise<CalendarDto> => {
  const res = await t.http
    .get('/api/calendar')
    .set(who.auth)
    .query({ from, to, ...query });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as CalendarDto;
};
const titles = (c: CalendarDto) => c.items.map((i) => i.title);
const changes = async (who: Account, cursors: Record<string, number>): Promise<SyncChangesDto> => {
  const res = await t.http
    .get('/api/sync/changes')
    .set(who.auth)
    .query({ cursors: JSON.stringify(cursors) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as SyncChangesDto;
};
const WINDOW = ['2027-03-01T00:00:00.000Z', '2027-05-01T00:00:00.000Z'] as const;

// ------------------------------------------------------------------ permissions

describe('who may do what', () => {
  it('creating a meeting needs CREATE_MEETINGS; somebody outside the team gets a 404', async () => {
    const team = await newTeam();
    expect((await eventRes(member, team.spaceId)).status).toBe(403);
    expect((await eventRes(outsider, team.spaceId)).status).toBe(404);
    expect((await eventRes(owner, team.spaceId)).status).toBe(201);
    await giveRole(team, member, P.CREATE_MEETINGS);
    expect((await eventRes(member, team.spaceId)).status).toBe(201);
  });

  it('a person always may use their own calendar, and nobody else sees into it', async () => {
    const mine = await personalSpaceId(t, member.id);
    const ev = await newEvent(member, mine, { title: 'Dentist' });
    expect(ev.spaceId).toBe(mine);
    expect((await t.http.get(`/api/events/${ev.id}`).set(other.auth)).status).toBe(404);
    expect((await eventRes(other, mine)).status).toBe(404);
    expect((await patchEvent(other, ev.id, { title: 'x' })).status).toBe(404);
    // nobody to invite in a personal calendar
    expect(
      (await eventRes(member, mine, { attendees: [{ kind: 'user', subjectId: other.id }] })).status,
    ).toBe(422);
  });

  it('naming others needs ADD_TO_MEMBER_CALENDARS, unless they opened their calendar to invitations', async () => {
    const team = await newTeam();
    await giveRole(team, member, P.CREATE_MEETINGS);
    const body = { attendees: [{ kind: 'user', subjectId: other.id }] };
    expect((await eventRes(member, team.spaceId, body)).status).toBe(403);
    // themselves only: fine
    expect(
      (
        await eventRes(member, team.spaceId, {
          attendees: [{ kind: 'user', subjectId: member.id }],
        })
      ).status,
    ).toBe(201);
    // `other` opens their calendar
    expect(
      (await t.http.put('/api/me/calendar-settings').set(other.auth).send({ openInvites: true }))
        .status,
    ).toBe(200);
    const people = await t.http.get(`/api/spaces/${team.spaceId}/calendar-people`).set(member.auth);
    expect(people.body.users.map((u: { userId: string }) => u.userId)).toEqual([other.id]);
    expect(people.body.roles).toEqual([]);
    expect((await eventRes(member, team.spaceId, body)).status).toBe(201);
    // roles always need the permission
    const role = await newRole(team);
    expect(
      (await eventRes(member, team.spaceId, { attendees: [{ kind: 'role', subjectId: role }] }))
        .status,
    ).toBe(403);
  });

  it('people who are not in the team, or whose role does not exist there, cannot be named', async () => {
    const team = await newTeam();
    await giveRole(team, member, P.CREATE_MEETINGS | P.ADD_TO_MEMBER_CALENDARS);
    expect(
      (
        await eventRes(member, team.spaceId, {
          attendees: [{ kind: 'user', subjectId: outsider.id }],
        })
      ).status,
    ).toBe(422);
    expect(
      (await eventRes(member, team.spaceId, { attendees: [{ kind: 'role', subjectId: uuid() }] }))
        .status,
    ).toBe(422);
    const people = await t.http.get(`/api/spaces/${team.spaceId}/calendar-people`).set(member.auth);
    const ids = people.body.users.map((u: { userId: string }) => u.userId);
    expect(ids).toContain(other.id);
    expect(ids).toContain(owner.id);
    expect(ids).not.toContain(outsider.id);
    const ok = await eventRes(member, team.spaceId, {
      attendees: [{ kind: 'user', subjectId: other.id }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(
      (await t.http.get(`/api/spaces/${team.spaceId}/calendar-people`).set(outsider.auth)).status,
    ).toBe(404);
  });

  it("changing somebody else's meeting needs MANAGE_MEETINGS", async () => {
    const team = await newTeam();
    await giveRole(team, member, P.CREATE_MEETINGS);
    const ev = await newEvent(owner, team.spaceId, { visibility: 'space' });
    expect((await patchEvent(member, ev.id, { title: 'Mine now' })).status).toBe(403);
    expect((await cancel(member, ev.id)).status).toBe(403);
    expect((await patchEvent(outsider, ev.id, { title: 'x' })).status).toBe(404);
    await giveRole(team, member, P.MANAGE_MEETINGS);
    expect((await patchEvent(member, ev.id, { title: 'Managed' })).status).toBe(200);
    expect((await detail(member, ev.id)).event.title).toBe('Managed');
  });

  it('an event for its attendees is invisible to everybody else (404), even to people who see the space', async () => {
    const team = await newTeam();
    const ev = await newEvent(owner, team.spaceId, {
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    expect((await t.http.get(`/api/events/${ev.id}`).set(member.auth)).status).toBe(200);
    expect((await t.http.get(`/api/events/${ev.id}`).set(other.auth)).status).toBe(404);
    expect((await rsvp(other, ev.id, 'accepted')).status).toBe(404);
    // shown to the whole space: seen, but only the people on it can answer
    await patchEvent(owner, ev.id, { visibility: 'space' });
    expect((await t.http.get(`/api/events/${ev.id}`).set(other.auth)).status).toBe(200);
    expect((await rsvp(other, ev.id, 'accepted')).status).toBe(403);
  });

  it('events are idempotent on their id, and need valid times', async () => {
    const team = await newTeam();
    const id = uuid();
    const a = await eventRes(owner, team.spaceId, { id });
    const b = await eventRes(owner, team.spaceId, { id });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await t.prisma.event.count({ where: { id } })).toBe(1);
    expect((await eventRes(member, team.spaceId, { id })).status).toBe(403);
    for (const bad of [
      { endAt: '2027-03-15T08:00:00.000Z' },
      { timezone: 'Nowhere/Land' },
      { rrule: 'FREQ=DAILY;BYSECOND=1' },
      { rrule: 'FREQ=DAILY;COUNT=99999' },
      { allDay: true },
    ])
      expect((await eventRes(owner, team.spaceId, bad)).status, JSON.stringify(bad)).toBe(422);
  });
});

// ------------------------------------------------------------------ the calendar

describe('GET /api/calendar', () => {
  it('lists own events, events the person attends, events shown to the space and assigned tasks, and nothing else', async () => {
    const team = await newTeam();
    const mine = await personalSpaceId(t, member.id);
    await newEvent(member, mine, { title: 'Own' });
    await newEvent(owner, team.spaceId, {
      title: 'Invited',
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    await newEvent(owner, team.spaceId, { title: 'Everyone', visibility: 'space' });
    await newEvent(owner, team.spaceId, { title: 'Secret' });
    await newEvent(other, await personalSpaceId(t, other.id), { title: "Other's own" });
    // a task assigned to the member with a date, one without a date and one for somebody else
    const board = await t.http
      .post(`/api/spaces/${team.spaceId}/boards`)
      .set(owner.auth)
      .send({ id: uuid(), name: 'B', position: 'a0' });
    expect(board.status).toBe(201);
    const column = (await t.http.get(`/api/boards/${board.body.id}`).set(owner.auth)).body
      .columns[0].id as string;
    const task = (title: string, body: object) =>
      t.http
        .post(`/api/boards/${board.body.id}/tasks`)
        .set(owner.auth)
        .send({
          id: uuid(),
          columnId: column,
          position: 'a' + Math.random().toString(36).slice(2, 6),
          title,
          ...body,
        });
    expect(
      (await task('Report', { dueAt: '2027-03-20T12:00:00.000Z', assigneeIds: [member.id] }))
        .status,
    ).toBe(201);
    expect((await task('Undated', { assigneeIds: [member.id] })).status).toBe(201);
    expect(
      (await task('Theirs', { dueAt: '2027-03-21T12:00:00.000Z', assigneeIds: [other.id] })).status,
    ).toBe(201);

    const c = await calendar(member, ...WINDOW);
    expect(titles(c).sort()).toEqual(['Everyone', 'Invited', 'Own', 'Report']);
    expect(c.items.find((i) => i.title === 'Report')).toMatchObject({
      source: 'task',
      allDay: false,
      completed: false,
    });
    expect(c.items.find((i) => i.title === 'Invited')).toMatchObject({
      source: 'event',
      rsvp: 'invited',
    });

    expect(titles(await calendar(owner, ...WINDOW)).sort()).toEqual([
      'Everyone',
      'Invited',
      'Secret',
    ]);
    expect(titles(await calendar(outsider, ...WINDOW))).toEqual([]);
    // filters
    expect(titles(await calendar(member, ...WINDOW, { include: 'tasks' }))).toEqual(['Report']);
    expect(titles(await calendar(member, ...WINDOW, { include: 'meetings' })).sort()).toEqual([
      'Everyone',
      'Invited',
      'Own',
    ]);
    expect(titles(await calendar(member, ...WINDOW, { include: 'events' }))).toEqual([]);
    expect(titles(await calendar(member, ...WINDOW, { spaces: mine }))).toEqual(['Own']);
  });

  it('expands a series, enforces the window, and flags overlapping entries', async () => {
    const team = await newTeam();
    await newEvent(owner, team.spaceId, {
      title: 'Daily',
      startAt: '2027-03-01T09:00:00.000Z',
      endAt: '2027-03-01T09:30:00.000Z',
      rrule: 'FREQ=DAILY',
      timezone: 'UTC',
    });
    const c = await calendar(owner, '2027-03-01T00:00:00.000Z', '2027-04-01T00:00:00.000Z');
    expect(c.items).toHaveLength(31);
    expect(c.truncated).toBe(false);
    expect(c.items[0]).toMatchObject({
      recurring: true,
      originalStart: '2027-03-01T09:00:00.000Z',
    });

    const big = await t.http
      .get('/api/calendar')
      .set(owner.auth)
      .query({ from: '2027-01-01T00:00:00.000Z', to: '2029-06-01T00:00:00.000Z' });
    expect(big.status).toBe(422);
    const upside = await t.http
      .get('/api/calendar')
      .set(owner.auth)
      .query({ from: '2027-04-01T00:00:00.000Z', to: '2027-03-01T00:00:00.000Z' });
    expect(upside.status).toBe(422);
    const two = await calendar(owner, '2027-01-01T00:00:00.000Z', '2028-12-31T00:00:00.000Z');
    expect(two.items.length).toBe(671);

    // overlap
    await newEvent(owner, team.spaceId, {
      title: 'Clash',
      startAt: '2027-03-01T09:15:00.000Z',
      endAt: '2027-03-01T10:00:00.000Z',
      timezone: 'UTC',
    });
    const d = await calendar(owner, '2027-03-01T00:00:00.000Z', '2027-03-03T00:00:00.000Z');
    expect(
      d.items
        .filter((i) => i.conflict)
        .map((i) => i.title)
        .sort(),
    ).toEqual(['Clash', 'Daily']);
  });

  it('shows all-day events as whole days', async () => {
    const team = await newTeam();
    await newEvent(owner, team.spaceId, {
      title: 'Holiday',
      allDay: true,
      startAt: '2027-03-10T00:00:00.000Z',
      endAt: '2027-03-12T00:00:00.000Z',
      timezone: 'Asia/Tokyo',
    });
    const c = await calendar(owner, ...WINDOW);
    expect(c.items[0]).toMatchObject({
      title: 'Holiday',
      allDay: true,
      start: '2027-03-10T00:00:00.000Z',
      end: '2027-03-12T00:00:00.000Z',
    });
    expect((await detail(owner, c.items[0]!.id)).event.timezone).toBe('UTC');
  });

  it('leaves out an event the person declined, unless asked', async () => {
    const team = await newTeam();
    const ev = await newEvent(owner, team.spaceId, {
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    expect((await rsvp(member, ev.id, 'declined')).status).toBe(200);
    expect(titles(await calendar(member, ...WINDOW))).toEqual([]);
    expect(titles(await calendar(member, ...WINDOW, { declined: 'true' }))).toEqual(['Sync']);
    expect((await detail(member, ev.id)).event.me?.status).toBe('declined'); // still theirs to open: the audit trail
  });

  it('forgets spaces the person lost: events and tasks of a team they left are gone', async () => {
    const team = await newTeam();
    await newEvent(owner, team.spaceId, {
      title: 'Invited',
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    expect(titles(await calendar(member, ...WINDOW))).toEqual(['Invited']);
    await t.prisma.teamMember.deleteMany({ where: { teamId: team.id, userId: member.id } });
    expect(titles(await calendar(member, ...WINDOW))).toEqual([]);
    const sync = await changes(member, { [team.spaceId]: 0 });
    expect(sync.revokedSpaces).toContain(team.spaceId);
  });
});

// ------------------------------------------------------------------ series

describe('repeating events', () => {
  const series = (team: Team, body: object = {}) =>
    newEvent(owner, team.spaceId, {
      title: 'Standup',
      startAt: '2027-03-01T09:00:00.000Z',
      endAt: '2027-03-01T09:30:00.000Z',
      timezone: 'Europe/Lisbon',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      visibility: 'space',
      ...body,
    });
  const starts = async (who: Account, to = '2027-05-01T00:00:00.000Z') =>
    (await calendar(who, '2027-03-01T00:00:00.000Z', to)).items.map((i) => i.start);

  it('"every Monday 09:00 Lisbon" follows the summer time change of 28 March 2027', async () => {
    const team = await newTeam();
    await series(team);
    expect(await starts(owner, '2027-04-13T00:00:00.000Z')).toEqual([
      '2027-03-01T09:00:00.000Z',
      '2027-03-08T09:00:00.000Z',
      '2027-03-15T09:00:00.000Z',
      '2027-03-22T09:00:00.000Z',
      '2027-03-29T08:00:00.000Z',
      '2027-04-05T08:00:00.000Z',
      '2027-04-12T08:00:00.000Z',
    ]);
  });

  it('changing one occurrence leaves the others alone', async () => {
    const team = await newTeam();
    const ev = await series(team);
    const res = await patchEvent(owner, ev.id, {
      scope: 'this',
      occurrence: '2027-03-15T09:00:00.000Z',
      title: 'Retro',
      startAt: '2027-03-16T10:00:00.000Z',
      endAt: '2027-03-16T11:00:00.000Z',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const c = await calendar(owner, '2027-03-01T00:00:00.000Z', '2027-03-23T00:00:00.000Z');
    expect(c.items.map((i) => [i.title, i.start])).toEqual([
      ['Standup', '2027-03-01T09:00:00.000Z'],
      ['Standup', '2027-03-08T09:00:00.000Z'],
      ['Retro', '2027-03-16T10:00:00.000Z'],
      ['Standup', '2027-03-22T09:00:00.000Z'],
    ]);
    expect(c.items[2]!.originalStart).toBe('2027-03-15T09:00:00.000Z');
    // only some fields may change for one occurrence; and it must be a real occurrence
    expect(
      (
        await patchEvent(owner, ev.id, {
          scope: 'this',
          occurrence: '2027-03-15T09:00:00.000Z',
          rrule: 'FREQ=DAILY',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await patchEvent(owner, ev.id, {
          scope: 'this',
          occurrence: '2027-03-16T09:00:00.000Z',
          title: 'x',
        })
      ).status,
    ).toBe(422);
    expect((await patchEvent(owner, ev.id, { scope: 'this', title: 'x' })).status).toBe(422);
  });

  it('cancelling one occurrence keeps the rest; cancelling the following ones ends the series', async () => {
    const team = await newTeam();
    const ev = await series(team);
    expect(
      (await cancel(owner, ev.id, { scope: 'this', occurrence: '2027-03-08T09:00:00.000Z' }))
        .status,
    ).toBe(204);
    expect(await starts(owner, '2027-03-23T00:00:00.000Z')).toEqual([
      '2027-03-01T09:00:00.000Z',
      '2027-03-15T09:00:00.000Z',
      '2027-03-22T09:00:00.000Z',
    ]);
    expect(
      (await cancel(owner, ev.id, { scope: 'following', occurrence: '2027-03-22T09:00:00.000Z' }))
        .status,
    ).toBe(204);
    expect(await starts(owner)).toEqual(['2027-03-01T09:00:00.000Z', '2027-03-15T09:00:00.000Z']);
    expect((await detail(owner, ev.id)).event.rrule).toContain('UNTIL=');
    // all of it
    expect((await cancel(owner, ev.id)).status).toBe(204);
    expect(await starts(owner)).toEqual([]);
    expect((await t.http.get(`/api/events/${ev.id}`).set(owner.auth)).status).toBe(404);
  });

  it('changing the following occurrences splits the series', async () => {
    const team = await newTeam();
    const ev = await series(team, { attendees: [{ kind: 'user', subjectId: member.id }] });
    await cancel(owner, ev.id, { scope: 'this', occurrence: '2027-03-29T08:00:00.000Z' });
    const res = await patchEvent(owner, ev.id, {
      scope: 'following',
      occurrence: '2027-03-22T09:00:00.000Z',
      title: 'Standup (new)',
      endAt: '2027-03-22T10:00:00.000Z',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const next = res.body as EventDto;
    expect(next.id).not.toBe(ev.id);
    expect(next.title).toBe('Standup (new)');
    expect(next.attendeeCount).toBe(2);

    const old = (await detail(owner, ev.id)).event;
    expect(old.rrule).toMatch(/UNTIL=20270322T085959Z/);
    expect(old.exceptions).toEqual([]);
    expect(next.exceptions.map((x) => x.originalStart)).toEqual(['2027-03-29T08:00:00.000Z']);

    const c = await calendar(member, '2027-03-01T00:00:00.000Z', '2027-04-13T00:00:00.000Z');
    expect(c.items.map((i) => [i.title, i.start, i.end])).toEqual([
      ['Standup', '2027-03-01T09:00:00.000Z', '2027-03-01T09:30:00.000Z'],
      ['Standup', '2027-03-08T09:00:00.000Z', '2027-03-08T09:30:00.000Z'],
      ['Standup', '2027-03-15T09:00:00.000Z', '2027-03-15T09:30:00.000Z'],
      ['Standup (new)', '2027-03-22T09:00:00.000Z', '2027-03-22T10:00:00.000Z'],
      ['Standup (new)', '2027-04-05T08:00:00.000Z', '2027-04-05T09:00:00.000Z'],
      ['Standup (new)', '2027-04-12T08:00:00.000Z', '2027-04-12T09:00:00.000Z'],
    ]);
    // a COUNT is shared out between the two halves
    const counted = await series(team, {
      rrule: 'FREQ=DAILY;COUNT=10',
      startAt: '2027-06-01T09:00:00.000Z',
      endAt: '2027-06-01T09:30:00.000Z',
    });
    const split = (
      await patchEvent(owner, counted.id, {
        scope: 'following',
        occurrence: '2027-06-04T09:00:00.000Z',
        title: 'Later',
      })
    ).body as EventDto;
    expect(split.rrule).toBe('FREQ=DAILY;COUNT=7');
    const all = await calendar(owner, '2027-06-01T00:00:00.000Z', '2027-07-01T00:00:00.000Z');
    expect(all.items.filter((i) => i.title === 'Standup')).toHaveLength(3);
    expect(all.items.filter((i) => i.title === 'Later')).toHaveLength(7);
  });

  it('changing all of it keeps the exceptions unless the time moves', async () => {
    const team = await newTeam();
    const ev = await series(team);
    await cancel(owner, ev.id, { scope: 'this', occurrence: '2027-03-08T09:00:00.000Z' });
    expect((await patchEvent(owner, ev.id, { title: 'Daily sync' })).status).toBe(200);
    expect((await detail(owner, ev.id)).event.exceptions).toHaveLength(1);
    expect(
      (
        await patchEvent(owner, ev.id, {
          startAt: '2027-03-01T10:00:00.000Z',
          endAt: '2027-03-01T10:30:00.000Z',
        })
      ).status,
    ).toBe(200);
    expect((await detail(owner, ev.id)).event.exceptions).toEqual([]);
    expect(await starts(owner, '2027-03-10T00:00:00.000Z')).toEqual([
      '2027-03-01T10:00:00.000Z',
      '2027-03-08T10:00:00.000Z',
    ]);
  });

  it('keeps the storage account straight', async () => {
    const before = await usedBytes(t, owner.id);
    const mine = await personalSpaceId(t, owner.id);
    const ev = await newEvent(owner, mine, { title: 'Dentist', description: 'x'.repeat(1000) });
    const used = (await usedBytes(t, owner.id)) - before;
    expect(used).toBeGreaterThan(1000);
    await patchEvent(owner, ev.id, { description: 'y' });
    expect((await usedBytes(t, owner.id)) - before).toBeLessThan(used);
    await cancel(owner, ev.id);
    expect(await usedBytes(t, owner.id)).toBe(before);
  });
});

// ------------------------------------------------------------------ answering

describe('answers', () => {
  it('only people on the event answer; the author sees the answers', async () => {
    const team = await newTeam();
    const ev = await newEvent(owner, team.spaceId, {
      attendees: [
        { kind: 'user', subjectId: member.id },
        { kind: 'user', subjectId: other.id },
      ],
    });
    expect((await detail(member, ev.id)).event.me).toMatchObject({
      status: 'invited',
      via: 'user',
      addedBy: owner.id,
    });
    expect((await rsvp(member, ev.id, 'accepted')).body.me.status).toBe('accepted');
    expect((await rsvp(other, ev.id, 'tentative')).status).toBe(200);
    expect((await rsvp(outsider, ev.id, 'accepted')).status).toBe(404);
    expect((await rsvp(member, ev.id, 'accepted', { scope: 'this' })).status).toBe(422);
    expect((await rsvp(member, ev.id, 'invited')).status).toBe(400);

    const seen = await detail(owner, ev.id);
    expect(seen.event.counts).toEqual({ invited: 0, accepted: 2, declined: 0, tentative: 1 });
    expect(seen.attendees.find((a) => a.subjectId === member.id)).toMatchObject({
      status: 'accepted',
      name: 'Test',
    });
    expect(seen.canEdit).toBe(true);
    expect((await detail(member, ev.id)).canEdit).toBe(false);
    // the author hears about it
    const row = await t.prisma.notification.findFirst({
      where: { userId: owner.id, kind: 'meeting_response' },
    });
    expect(row).toMatchObject({ targetKind: 'event', targetId: ev.id, actorId: member.id });
  });

  it("a role on an event reaches whoever holds it, now and later; an answer is the person's own", async () => {
    const team = await newTeam();
    const role = await newRole(team);
    const ev = await newEvent(owner, team.spaceId, {
      attendees: [{ kind: 'role', subjectId: role }],
    });
    expect(titles(await calendar(member, ...WINDOW))).toEqual([]);

    expect((await assign(team, member, role)).status).toBe(204);
    expect(titles(await calendar(member, ...WINDOW))).toEqual(['Sync']);
    expect((await detail(member, ev.id)).event.me).toMatchObject({
      status: 'invited',
      via: 'role',
    });
    expect((await detail(owner, ev.id)).attendees.find((a) => a.kind === 'role')).toMatchObject({
      subjectId: role,
      memberCount: 1,
    });
    expect((await rsvp(member, ev.id, 'accepted')).status).toBe(200);
    expect((await detail(member, ev.id)).event.me).toMatchObject({
      status: 'accepted',
      via: 'user',
    });
    expect((await detail(owner, ev.id)).event.counts.accepted).toBe(2);

    // leaving the role takes the event away (the answer already given stays a person's own: they stay on it)
    expect((await changes(other, { [team.spaceId]: 0 })).spaces[team.spaceId]!.events).toEqual([]);
    expect((await assign(team, other, role)).status).toBe(204);
    const before = await changes(other, { [team.spaceId]: 0 });
    expect(before.spaces[team.spaceId]!.events!.map((e) => e.id)).toEqual([ev.id]);
    const cursor = before.spaces[team.spaceId]!.cursor;
    expect((await unassign(team, other, role)).status).toBe(204);
    const after = await changes(other, { [team.spaceId]: cursor });
    expect(after.spaces[team.spaceId]!.hiddenEvents).toEqual([ev.id]);
    expect(titles(await calendar(other, ...WINDOW))).toEqual([]);
  });

  it('adding and removing people later, and declining keeps the trail', async () => {
    const team = await newTeam();
    await giveRole(team, member, P.CREATE_MEETINGS | P.ADD_TO_MEMBER_CALENDARS);
    const ev = await newEvent(member, team.spaceId);
    const add = await t.http
      .post(`/api/events/${ev.id}/attendees`)
      .set(member.auth)
      .send({ attendees: [{ kind: 'user', subjectId: other.id, optional: true }] });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.attendees.map((a: { subjectId: string }) => a.subjectId).sort()).toEqual(
      [member.id, other.id].sort(),
    );
    expect((await detail(other, ev.id)).event.me).toMatchObject({
      addedBy: member.id,
      addedByName: 'Test',
      optional: true,
    });
    expect(
      (
        await t.http
          .post(`/api/events/${ev.id}/attendees`)
          .set(other.auth)
          .send({ attendees: [{ kind: 'user', subjectId: member.id }] })
      ).status,
    ).toBe(403);

    await rsvp(other, ev.id, 'declined');
    expect(
      await t.prisma.eventAttendee.findFirst({ where: { eventId: ev.id, subjectId: other.id } }),
    ).toMatchObject({ status: 'declined' });
    expect(
      (await t.http.delete(`/api/events/${ev.id}/attendees/user/${member.id}`).set(member.auth))
        .status,
    ).toBe(422); // the author stays
    expect(
      (await t.http.delete(`/api/events/${ev.id}/attendees/user/${other.id}`).set(member.auth))
        .status,
    ).toBe(200);
    expect((await t.http.get(`/api/events/${ev.id}`).set(other.auth)).status).toBe(404);
  });

  it('duplicates an event, also to another day', async () => {
    const team = await newTeam();
    const ev = await newEvent(owner, team.spaceId, {
      title: 'Review',
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    const res = await t.http
      .post(`/api/events/${ev.id}/duplicate`)
      .set(owner.auth)
      .send({ id: uuid(), startAt: '2027-03-22T09:00:00.000Z' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Review',
      startAt: '2027-03-22T09:00:00.000Z',
      endAt: '2027-03-22T10:00:00.000Z',
      attendeeCount: 1,
    });
    expect(
      (await t.http.post(`/api/events/${ev.id}/duplicate`).set(member.auth).send({ id: uuid() }))
        .status,
    ).toBe(403);
  });
});

// ------------------------------------------------------------------ reminders

describe('reminders', () => {
  const reminders = () => t.app.get(RemindersService);
  const told = (who: Account) =>
    t.prisma.notification.findMany({ where: { userId: who.id, kind: 'meeting_reminder' } });

  it('are sent once to everybody on the event, however many workers run', async () => {
    const team = await newTeam();
    const ev = await newEvent(owner, team.spaceId, {
      title: 'Soon',
      startAt: at(8),
      endAt: at(38),
      timezone: 'UTC',
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    expect(await reminders().sweep(new Date())).toBe(2); // default: 10 minutes before
    expect(await told(member)).toHaveLength(1);
    expect(await told(owner)).toHaveLength(1);
    expect((await told(member))[0]).toMatchObject({
      targetKind: 'event',
      targetId: ev.id,
      summary: 'Soon',
    });
    expect(await reminders().sweep(new Date())).toBe(0);

    // two workers at once: still once
    await newEvent(owner, team.spaceId, {
      title: 'Race',
      startAt: at(9),
      endAt: at(30),
      timezone: 'UTC',
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    const sent = await Promise.all([reminders().sweep(new Date()), reminders().sweep(new Date())]);
    expect(sent[0]! + sent[1]!).toBe(2);
    expect(await told(member)).toHaveLength(2);
  });

  it('not yet, not for what started, not for what was cancelled or declined', async () => {
    const team = await newTeam();
    await newEvent(owner, team.spaceId, {
      title: 'Later',
      startAt: at(120),
      endAt: at(150),
      timezone: 'UTC',
    });
    await newEvent(owner, team.spaceId, {
      title: 'Started',
      startAt: at(-5),
      endAt: at(25),
      timezone: 'UTC',
    });
    const gone = await newEvent(owner, team.spaceId, {
      title: 'Gone',
      startAt: at(5),
      endAt: at(25),
      timezone: 'UTC',
    });
    await cancel(owner, gone.id);
    const declined = await newEvent(owner, team.spaceId, {
      title: 'No',
      startAt: at(5),
      endAt: at(25),
      timezone: 'UTC',
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    await rsvp(member, declined.id, 'declined');
    await reminders().sweep(new Date());
    expect((await told(owner)).map((n) => n.summary)).toEqual(['No']);
    expect(await told(member)).toHaveLength(0);
  });

  it("follow each person's own settings: their defaults, and their own list on one event", async () => {
    const team = await newTeam();
    const ev = await newEvent(owner, team.spaceId, {
      title: 'Custom',
      startAt: at(40),
      endAt: at(70),
      timezone: 'UTC',
      attendees: [
        { kind: 'user', subjectId: member.id },
        { kind: 'user', subjectId: other.id },
      ],
    });
    expect(
      (
        await t.http
          .put('/api/me/calendar-settings')
          .set(member.auth)
          .send({ defaultReminders: [] })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.http
          .put('/api/me/calendar-settings')
          .set(other.auth)
          .send({ defaultReminders: [60] })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.http
          .put(`/api/events/${ev.id}/reminders`)
          .set(owner.auth)
          .send({ minutes: [30, 45] })
      ).status,
    ).toBe(200);
    await reminders().sweep(new Date());
    expect(await told(member)).toHaveLength(0);
    expect(await told(other)).toHaveLength(1); // 60 minutes before: due
    expect(await told(owner)).toHaveLength(1); // 45 minutes before: due, 30 not yet
    expect(
      (
        await t.http
          .put(`/api/events/${ev.id}/reminders`)
          .set(member.auth)
          .send({ minutes: [41] })
      ).status,
    ).toBe(200);
    expect((await detail(member, ev.id)).reminders).toEqual([41]);
    expect(await reminders().sweep(new Date())).toBe(1);
    expect(
      (await t.http.put(`/api/events/${ev.id}/reminders`).set(member.auth).send({ minutes: null }))
        .status,
    ).toBe(200);
    expect((await detail(member, ev.id)).reminders).toBeNull();
  });

  it('reach people in the app, by push and (when asked) by email; a muted team hears nothing', async () => {
    const team = await newTeam();
    const push = vi.spyOn(t.app.get(PushService), 'notify').mockResolvedValue(undefined as never);
    await newEvent(owner, team.spaceId, {
      title: 'Loud',
      startAt: at(5),
      endAt: at(35),
      timezone: 'UTC',
      attendees: [
        { kind: 'user', subjectId: member.id },
        { kind: 'user', subjectId: other.id },
      ],
    });
    expect(
      (
        await t.http
          .put('/api/me/calendar-settings')
          .set(member.auth)
          .send({ emailReminders: true })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.http
          .post('/api/notification-settings/mute')
          .set(other.auth)
          .send({ scopeKind: 'team', scopeId: team.id, until: MUTED_FOREVER })
      ).status,
    ).toBeLessThan(300);
    push.mockClear();
    const socket = await connect(url, member.token);
    const live = collect<{ kind: string }>(socket, NOTIFY_EVENTS.created);
    const due = collect<{ title: string }>(socket, CALENDAR_EVENTS.reminderDue);
    await sleep(200);
    await reminders().sweep(new Date());
    await sleep(300);

    expect(await told(member)).toHaveLength(1);
    expect(live.map((n) => n.kind)).toEqual(['meeting_reminder']);
    expect(due.map((d) => d.title)).toEqual(['Loud']);
    expect(await told(other)).toHaveLength(0); // muted
    expect(push.mock.calls.map((c) => c[0]).sort()).toEqual([owner.id, member.id].sort());
    expect(t.mail.sent.filter((m) => m.kind === 'reminder').map((m) => m.to)).toEqual([
      member.email,
    ]);
    expect(t.mail.last('reminder', member.email)?.reminder?.title).toBe('Loud');
  });

  it('a series is reminded occurrence by occurrence', async () => {
    const team = await newTeam();
    const start = Math.floor((Date.now() + 5 * MIN) / MIN) * MIN;
    await newEvent(owner, team.spaceId, {
      title: 'Daily',
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + 30 * MIN).toISOString(),
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
    });
    expect(await reminders().sweep(new Date())).toBe(1);
    expect(await reminders().sweep(new Date())).toBe(0);
    // a day later the next one is due
    expect(await reminders().sweep(new Date(Date.now() + 24 * HOUR))).toBe(1);
  });
});

// ------------------------------------------------------------------ sync

describe('sync', () => {
  it('brings the events a person may see, as they see them, and tombstones', async () => {
    const team = await newTeam();
    const ev = await newEvent(owner, team.spaceId, {
      title: 'Planning',
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    await newEvent(owner, team.spaceId, { title: 'Private' });
    const mine = await changes(member, { [team.spaceId]: 0 });
    const space = mine.spaces[team.spaceId]!;
    expect(space.events!.map((e) => e.title)).toEqual(['Planning']);
    expect(space.events![0]).toMatchObject({
      id: ev.id,
      ownerName: 'Test',
      me: { status: 'invited', addedBy: owner.id },
      attendeeCount: 2,
    });
    expect(space.hiddenEvents).toBeDefined(); // the private one changed and is not theirs: drop it if held
    const ownerView = await changes(owner, { [team.spaceId]: 0 });
    expect(ownerView.spaces[team.spaceId]!.events!.map((e) => e.title).sort()).toEqual([
      'Planning',
      'Private',
    ]);

    await cancel(owner, ev.id);
    const next = await changes(member, { [team.spaceId]: space.cursor });
    expect(next.spaces[team.spaceId]!.events!).toMatchObject([
      { id: ev.id, deletedAt: expect.any(String) },
    ]);
    expect((await changes(outsider, { [team.spaceId]: 0 })).revokedSpaces).toEqual([team.spaceId]);
  });

  it('a person gets their personal events through their personal space', async () => {
    const mine = await personalSpaceId(t, member.id);
    await newEvent(member, mine, { title: 'Dentist' });
    const res = await changes(member, { [mine]: 0 });
    expect(res.spaces[mine]!.events!.map((e) => e.title)).toEqual(['Dentist']);
  });

  it('applies what a device queued while it was offline', async () => {
    const team = await newTeam();
    const id = uuid();
    const ops = [
      {
        opId: uuid(),
        type: 'event.create',
        id,
        spaceId: team.spaceId,
        title: 'Offline',
        startAt: '2027-03-15T09:00:00.000Z',
        endAt: '2027-03-15T10:00:00.000Z',
        timezone: 'UTC',
        attendees: [{ kind: 'user', subjectId: member.id }],
      },
      { opId: uuid(), type: 'event.update', id, title: 'Offline (edited)' },
      { opId: uuid(), type: 'event.rsvp', id, status: 'accepted' },
    ];
    const res = await t.http.post('/api/sync/batch').set(owner.auth).send({ ops });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true]);
    expect((await detail(member, id)).event.title).toBe('Offline (edited)');
    const again = await t.http
      .post('/api/sync/batch')
      .set(owner.auth)
      .send({ ops: [ops[0]] });
    expect(again.body.results[0].ok).toBe(true); // the same create twice: still one event
    expect(await t.prisma.event.count({ where: { id } })).toBe(1);
    const bad = await t.http
      .post('/api/sync/batch')
      .set(outsider.auth)
      .send({ ops: [{ opId: uuid(), type: 'event.update', id, title: 'x' }] });
    expect(bad.body.results[0]).toMatchObject({ ok: false, error: 'not_found' });
  });
});

// ------------------------------------------------------------------ realtime and settings

describe('live updates and settings', () => {
  it('tells the people concerned (and nobody else) when an event is made or changed', async () => {
    const team = await newTeam();
    const spaceSocket = await connect(url, other.token);
    const mineSocket = await connect(url, member.token);
    expect(await ack(spaceSocket, 'room:join', { kind: 'space', id: team.spaceId })).toMatchObject({
      ok: true,
    });
    const heardSpace = collect<{ spaceId: string; id: string }>(
      spaceSocket,
      CALENDAR_EVENTS.eventCreated,
    );
    const invited = collect<{ id: string }>(mineSocket, CALENDAR_EVENTS.eventInvited);
    const updated = collect<{ id: string }>(mineSocket, CALENDAR_EVENTS.eventUpdated);
    await sleep(200);
    const ev = await newEvent(owner, team.spaceId, {
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    await patchEvent(owner, ev.id, {
      title: 'Moved',
      startAt: '2027-03-16T09:00:00.000Z',
      endAt: '2027-03-16T10:00:00.000Z',
    });
    await sleep(300);
    expect(heardSpace.map((e) => e.id)).toEqual([ev.id]); // only that something happened
    expect(heardSpace[0]).toEqual({ spaceId: team.spaceId, id: ev.id });
    expect(invited.map((e) => e.id)).toEqual([ev.id]);
    expect(updated.length).toBeGreaterThan(0);
    const rows = await t.prisma.notification.findMany({
      where: { userId: member.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.kind)).toEqual(['meeting_invite', 'meeting_updated']);
  });

  it('keeps settings per person', async () => {
    const def = await t.http.get('/api/me/calendar-settings').set(member.auth);
    expect(def.body).toEqual({
      defaultTz: null,
      weekStart: 1,
      defaultReminders: [10],
      hiddenSpaces: [],
      openInvites: false,
      emailReminders: false,
    });
    const put = await t.http
      .put('/api/me/calendar-settings')
      .set(member.auth)
      .send({ defaultTz: 'Europe/Lisbon', weekStart: 0, defaultReminders: [30, 5, 5] });
    expect(put.body).toMatchObject({
      defaultTz: 'Europe/Lisbon',
      weekStart: 0,
      defaultReminders: [5, 30],
    });
    expect(
      (
        await t.http
          .put('/api/me/calendar-settings')
          .set(member.auth)
          .send({ defaultTz: 'Mars/Base' })
      ).status,
    ).toBe(422);
    expect(
      (await t.http.put('/api/me/calendar-settings').set(member.auth).send({ weekStart: 3 }))
        .status,
    ).toBe(400);
    expect((await t.http.get('/api/me/calendar-settings').set(other.auth)).body.weekStart).toBe(1);
  });

  it('says what a person may do in each space', async () => {
    const team = await newTeam();
    await giveRole(team, member, P.CREATE_MEETINGS);
    const mine = await personalSpaceId(t, member.id);
    const res = await t.http.get('/api/calendar-permissions').set(member.auth);
    expect(Object.keys(res.body.spaces).sort()).toEqual([mine, team.spaceId].sort());
    const bits = BigInt(res.body.spaces[team.spaceId]);
    expect((bits & P.CREATE_MEETINGS) !== 0n).toBe(true);
    expect((bits & P.MANAGE_MEETINGS) !== 0n).toBe(false);
    expect(
      Object.keys((await t.http.get('/api/calendar-permissions').set(outsider.auth)).body.spaces),
    ).toEqual([await personalSpaceId(t, outsider.id)]);
  });
});
