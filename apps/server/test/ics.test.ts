import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Permission,
  permissionsToString,
  type CalendarDto,
  type CalendarFeedSecretDto,
  type ExternalCalendarDto,
  type IcsImportPreviewDto,
  type IcsImportResultDto,
} from '@os-planner/shared';
import { ENV, type Env } from '../src/config/env.js';
import { ExternalCalendarsService } from '../src/ics/external.service.js';
import { IcsFetcher } from '../src/ics/ics-fetcher.js';
import { IcsFetchError, type TransportRequest } from '../src/ics/safe-fetch.js';
import { sha256Hex } from '../src/common/crypto.js';
import { createTestApp, type TestApp } from './app.js';
import { personalSpaceId, signup, usedBytes, uuid, type Account } from './helpers.js';

const P = Permission;
const ADMIN_EMAIL = `ics-admin${Date.now()}@example.com`;
const fixture = (name: string): string =>
  readFileSync(
    resolve(import.meta.dirname, '../../../packages/shared/src/ics/fixtures', `${name}.ics`),
    'utf8',
  );

let t: TestApp;
let fetcher: IcsFetcher;
let external: ExternalCalendarsService;
let env: Env;
let saved: string | undefined;
let admin: Account;
let owner: Account;
let member: Account;
let outsider: Account;

/** What the pretend network answers. */
const serve = {
  body: '',
  etag: '' as string | undefined,
  fail: undefined as undefined | IcsFetchError['code'],
  delay: 0,
};
let calls: TransportRequest[] = [];
let running = 0;
let peak = 0;

beforeAll(async () => {
  saved = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  t = await createTestApp();
  fetcher = t.app.get(IcsFetcher);
  external = t.app.get(ExternalCalendarsService);
  env = t.app.get<Env>(ENV);
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
  serve.body = fixture('google');
  serve.etag = '"v1"';
  serve.fail = undefined;
  serve.delay = 0;
  calls = [];
  running = peak = 0;
  fetcher.resolve = async () => ['93.184.216.34'];
  fetcher.transport = async (r) => {
    calls.push(r);
    running++;
    peak = Math.max(peak, running);
    try {
      if (serve.delay) await new Promise((res) => setTimeout(res, serve.delay));
      if (serve.fail) throw new IcsFetchError(serve.fail);
      if (serve.etag && r.headers['If-None-Match'] === serve.etag)
        return { status: 304, headers: {}, body: Buffer.alloc(0) };
      return {
        status: 200,
        headers: { 'content-type': 'text/calendar', ...(serve.etag ? { etag: serve.etag } : {}) },
        body: Buffer.from(serve.body),
      };
    } finally {
      running--;
    }
  };
});
afterEach(() => {
  fetcher.resolve = undefined;
  fetcher.transport = undefined;
  fetcher.limits = {};
});

// ------------------------------------------------------------------ helpers

interface Team {
  id: string;
  spaceId: string;
}

async function newTeam(members: Account[] = [member]): Promise<Team> {
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

async function giveRole(team: Team, who: Account, bits: bigint): Promise<void> {
  const role = await t.http
    .post(`/api/teams/${team.id}/roles`)
    .set(owner.auth)
    .send({
      name: `role${Math.random().toString(36).slice(2, 8)}`,
      permissions: permissionsToString(bits),
    });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  expect(
    (
      await t.http
        .put(`/api/teams/${team.id}/members/${who.id}/roles/${role.body.id}`)
        .set(owner.auth)
    ).status,
  ).toBe(204);
}

async function newEvent(who: Account, spaceId: string, body: object = {}) {
  const res = await t.http
    .post('/api/events')
    .set(who.auth)
    .send({
      id: uuid(),
      spaceId,
      title: 'Planning',
      startAt: '2027-03-15T09:00:00.000Z',
      endAt: '2027-03-15T10:00:00.000Z',
      timezone: 'Europe/Lisbon',
      ...body,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; title: string };
}

const newFeed = async (
  who: Account,
  body: object = { name: 'Phone' },
): Promise<CalendarFeedSecretDto> => {
  const res = await t.http.post('/api/me/feeds').set(who.auth).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as CalendarFeedSecretDto;
};
const pathOf = (url: string): string => new URL(url).pathname;
const tokenOf = (url: string): string => /\/feeds\/([^/]+)\.ics$/.exec(url)![1]!;
const fetchFeed = (url: string, headers: Record<string, string> = {}) =>
  t.http.get(pathOf(url)).set(headers);

const calendar = async (
  who: Account,
  from: string,
  to: string,
  include = 'external',
): Promise<CalendarDto> => {
  const res = await t.http.get('/api/calendar').set(who.auth).query({ from, to, include });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as CalendarDto;
};

const follow = (who: Account, body: object = {}) =>
  t.http
    .post('/api/me/external-calendars')
    .set(who.auth)
    .send({ name: 'Work', url: 'https://calendar.example.com/work.ics', ...body });

// ------------------------------------------------------------------ the private feed

describe('feeds', () => {
  it('makes a secret address, shows it once, and keeps only a hash', async () => {
    const feed = await newFeed(owner);
    expect(feed.url).toMatch(/\/api\/feeds\/[A-Za-z0-9_-]{43}\.ics$/);
    const token = tokenOf(feed.url);
    expect(feed.tokenHint).toBe(token.slice(-6));
    const row = await t.prisma.calendarFeed.findFirstOrThrow({ where: { userId: owner.id } });
    expect(row.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const list = await t.http.get('/api/me/feeds').set(owner.auth);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body[0]).toMatchObject({
      name: 'Phone',
      include: { spaces: null, tasks: true, meetings: true, events: true, declined: false },
    });
    expect((await t.http.get('/api/me/feeds')).status).toBe(401);
  });

  it('keeps at most ten per person, and nobody else can touch them', async () => {
    const first = await newFeed(owner);
    for (let i = 1; i < 10; i++) await newFeed(owner, { name: `Feed ${i}` });
    const eleventh = await t.http.post('/api/me/feeds').set(owner.auth).send({ name: 'One more' });
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.message).toBe('too_many_feeds');
    const id = first.id;
    expect(
      (await t.http.patch(`/api/me/feeds/${id}`).set(member.auth).send({ name: 'Mine' })).status,
    ).toBe(404);
    expect((await t.http.post(`/api/me/feeds/${id}/rotate`).set(member.auth)).status).toBe(404);
    expect((await t.http.delete(`/api/me/feeds/${id}`).set(member.auth)).status).toBe(404);
    expect((await t.http.delete(`/api/me/feeds/${id}`).set(owner.auth)).status).toBe(204);
  });

  it('serves the calendar to anybody holding the address, with the headers a calendar app needs', async () => {
    const personal = await personalSpaceId(t, owner.id);
    await newEvent(owner, personal, {
      title: 'Dentist, 9am',
      description: 'Bring the card;\nsecond line',
      location: 'Lisboa',
      rrule: 'FREQ=WEEKLY;COUNT=3',
    });
    const feed = await newFeed(owner);
    const res = await fetchFeed(feed.url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['etag']).toBeTruthy();
    expect(res.headers['last-modified']).toBeTruthy();
    const body = res.text;
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('SUMMARY:Dentist\\, 9am');
    expect(body).toContain('DESCRIPTION:Bring the card\\;\\nsecond line');
    expect(body).toContain('RRULE:FREQ=WEEKLY;COUNT=3');
    expect(body).toContain('TZID:Europe/Lisbon');
    expect(body).toContain('X-PUBLISHED-TTL:PT1H');
    expect(body).toContain('TRIGGER:-PT10M'); // the person's default reminder
    expect(body).toMatch(/UID:[0-9a-f-]{36}@/);
    // The address leaves nothing in logs or referrers, and the page lists a hit.
    const row = await t.prisma.calendarFeed.findFirstOrThrow({ where: { id: feed.id } });
    expect(row.fetchCount).toBe(1);
    expect(row.lastFetchedAt).not.toBeNull();
  });

  it('answers 304 to a repeat and a new file when the calendar changes', async () => {
    const personal = await personalSpaceId(t, owner.id);
    await newEvent(owner, personal);
    const feed = await newFeed(owner);
    const first = await fetchFeed(feed.url);
    const etag = first.headers['etag']!;
    const again = await fetchFeed(feed.url, { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
    expect(
      (await fetchFeed(feed.url, { 'If-Modified-Since': first.headers['last-modified']! })).status,
    ).toBe(304);
    await newEvent(owner, personal, { title: 'Second' });
    const changed = await fetchFeed(feed.url, { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers['etag']).not.toBe(etag);
    expect(changed.text).toContain('SUMMARY:Second');
  });

  it('answers the same 404 for a wrong, a renewed and a deleted address', async () => {
    const feed = await newFeed(owner);
    expect((await fetchFeed(feed.url)).status).toBe(200);
    const rotated = await t.http.post(`/api/me/feeds/${feed.id}/rotate`).set(owner.auth);
    expect(rotated.status).toBe(200);
    const renewed = rotated.body as CalendarFeedSecretDto;
    expect(renewed.url).not.toBe(feed.url);
    expect(renewed.rotatedAt).not.toBeNull();
    const old = await fetchFeed(feed.url);
    const fresh = await fetchFeed(renewed.url);
    expect(old.status).toBe(404);
    expect(fresh.status).toBe(200);
    await t.http.delete(`/api/me/feeds/${feed.id}`).set(owner.auth);
    const deleted = await fetchFeed(renewed.url);
    const wrong = await fetchFeed(`https://x.test/api/feeds/${'A'.repeat(43)}.ics`);
    const malformed = await t.http.get('/api/feeds/not-a-token.ics');
    for (const r of [deleted, wrong, malformed]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(old.body);
      expect(r.text).toBe(old.text);
    }
  });

  it('is computed with the owner’s permissions at the moment of the request', async () => {
    const team = await newTeam([member]);
    const personal = await personalSpaceId(t, member.id);
    const shared = await newEvent(owner, team.spaceId, {
      title: 'Team all-hands',
      visibility: 'space',
    });
    await newEvent(member, personal, { title: 'My dentist' });
    await newEvent(owner, await personalSpaceId(t, owner.id), { title: 'Owner private' });
    const feed = await newFeed(member);
    const body = (await fetchFeed(feed.url)).text;
    expect(body).toContain('SUMMARY:Team all-hands');
    expect(body).toContain('SUMMARY:My dentist');
    expect(body).not.toContain('Owner private');
    expect(shared.id).toBeTruthy();
    // Losing the space removes its events on the next fetch.
    await t.prisma.teamMember.deleteMany({ where: { teamId: team.id, userId: member.id } });
    const after = (await fetchFeed(feed.url)).text;
    expect(after).not.toContain('Team all-hands');
    expect(after).toContain('SUMMARY:My dentist');
  });

  it('holds only what was chosen, and leaves out what the person declined', async () => {
    const team = await newTeam([member]);
    const personal = await personalSpaceId(t, member.id);
    await newEvent(member, personal, { title: 'My dentist' });
    const invited = await newEvent(owner, team.spaceId, {
      title: 'Invited meeting',
      attendees: [{ kind: 'user', subjectId: member.id }],
    });
    await newEvent(owner, team.spaceId, {
      title: 'Everyone event',
      visibility: 'space',
      kind: 'event',
    });

    const onlyPersonal = await newFeed(member, {
      name: 'Personal',
      include: { spaces: [personal] },
    });
    const a = (await fetchFeed(onlyPersonal.url)).text;
    expect(a).toContain('My dentist');
    expect(a).not.toContain('Invited meeting');
    expect(a).not.toContain('Everyone event');

    const onlyTeam = await newFeed(member, {
      name: 'Team',
      include: { spaces: [team.spaceId], events: false },
    });
    const b = (await fetchFeed(onlyTeam.url)).text;
    expect(b).toContain('Invited meeting');
    expect(b).not.toContain('Everyone event'); // events are switched off
    expect(b).not.toContain('My dentist');

    const all = await newFeed(member, { name: 'All' });
    expect((await fetchFeed(all.url)).text).toContain('PARTSTAT=NEEDS-ACTION');
    expect(
      (
        await t.http
          .post(`/api/events/${invited.id}/rsvp`)
          .set(member.auth)
          .send({ status: 'declined' })
      ).status,
    ).toBe(200);
    expect((await fetchFeed(all.url)).text).not.toContain('Invited meeting');
    const patched = await t.http
      .patch(`/api/me/feeds/${all.id}`)
      .set(member.auth)
      .send({ include: { declined: true } });
    expect(patched.body.include.declined).toBe(true);
    const withDeclined = (await fetchFeed(all.url)).text;
    expect(withDeclined).toContain('SUMMARY:Invited meeting');
    expect(withDeclined).toContain('PARTSTAT=DECLINED');
  });

  it('limits how often one feed may be fetched', async () => {
    const feed = await newFeed(owner);
    let limited = 0;
    for (let i = 0; i < 70; i++) if ((await fetchFeed(feed.url)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ calendars the person follows

describe('followed calendars', () => {
  it('reads an address, keeps its events and shows them on the calendar of that person only', async () => {
    const res = await follow(owner, { color: '#aa3300' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const cal = res.body as ExternalCalendarDto;
    expect(cal).toMatchObject({
      name: 'Work',
      color: '#aa3300',
      enabled: true,
      eventCount: 3,
      lastError: null,
      syncEveryMinutes: 60,
    });
    expect(calls).toHaveLength(1);

    const window = await calendar(owner, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    const standups = window.items.filter(
      (i) => i.source === 'external' && i.title.startsWith('Standup'),
    );
    expect(standups.map((i) => [i.title, i.start])).toEqual([
      ['Standup', '2026-10-05T08:30:00.000Z'],
      ['Standup (moved)', '2026-10-12T10:00:00.000Z'],
      ['Standup', '2026-10-26T09:30:00.000Z'],
    ]);
    expect(standups[0]).toMatchObject({
      color: '#aa3300',
      sourceName: 'Work',
      calendarId: cal.id,
      location: 'Room 1, HQ',
      spaceId: '',
    });
    const nov = await calendar(owner, '2026-11-09T00:00:00.000Z', '2026-11-12T00:00:00.000Z');
    expect(nov.items.map((i) => i.title)).toContain('Dentist');

    expect(
      (await calendar(member, '2026-10-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z')).items,
    ).toEqual([]);
    expect(
      (
        await t.http
          .get(`/api/me/external-calendars/${cal.id}/events`)
          .set(member.auth)
          .query({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' })
      ).status,
    ).toBe(404);
    const own = await t.http
      .get(`/api/me/external-calendars/${cal.id}/events`)
      .set(owner.auth)
      .query({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' });
    expect(own.body.items).toHaveLength(3);
    // They are not part of the calendar unless asked for.
    expect(
      (
        await calendar(
          owner,
          '2026-10-01T00:00:00.000Z',
          '2026-11-01T00:00:00.000Z',
          'events,meetings',
        )
      ).items,
    ).toEqual([]);
  });

  it('refuses an address that points inside, with nothing saved and nothing sent', async () => {
    fetcher.resolve = async (host) => (host === 'meta.test' ? ['169.254.169.254'] : ['10.0.0.8']);
    for (const url of [
      'https://meta.test/a.ics',
      'https://lan.test/a.ics',
      'http://127.0.0.1:3000/api/health',
      'http://[::1]/a.ics',
    ]) {
      const res = await follow(owner, { url });
      expect(res.status, url).toBe(422);
      expect(res.body.message, url).toBe('ics_blocked_address');
    }
    expect(calls).toHaveLength(0);
    expect(await t.prisma.externalCalendar.count()).toBe(0);
    for (const url of [
      'file:///etc/passwd',
      'ftp://x.test/a',
      'https://u:p@x.test/a.ics',
      'nonsense',
    ])
      expect((await follow(owner, { url })).body.message, url).toBe('ics_bad_url');
  });

  it('says what was wrong with a calendar it could not take', async () => {
    serve.body = '<html>not a calendar</html>';
    expect((await follow(owner)).body.message).toBe('ics_not_a_calendar');
    serve.fail = 'ics_timeout';
    expect((await follow(owner)).body.message).toBe('ics_timeout');
    serve.fail = undefined;
    serve.body =
      'BEGIN:VCALENDAR\n' +
      Array.from(
        { length: 25 },
        (_v, i) => `BEGIN:VEVENT\nUID:e${i}\nDTSTART:20270101T090000Z\nEND:VEVENT\n`,
      ).join('') +
      'END:VCALENDAR\n';
    expect((await follow(owner)).status).toBe(201); // 25 events are fine
    expect(await t.prisma.externalCalendar.count()).toBe(1);
  });

  it('asks "has it changed?", replaces what changed, and waits between hand refreshes', async () => {
    const cal = (await follow(owner)).body as ExternalCalendarDto;
    const first = await t.http.post(`/api/me/external-calendars/${cal.id}/refresh`).set(owner.auth);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(calls.at(-1)!.headers['If-None-Match']).toBe('"v1"'); // the validator kept at the first read
    expect(first.body.lastSyncAt).not.toBeNull();
    // Another hand refresh straight away is too soon.
    const second = await t.http
      .post(`/api/me/external-calendars/${cal.id}/refresh`)
      .set(owner.auth);
    expect(second.status).toBe(429);
    expect(second.body.message).toBe('refresh_too_soon');
    expect(calls).toHaveLength(2);

    // After the wait, a changed file replaces the events.
    await t.prisma.externalCalendar.update({
      where: { id: cal.id },
      data: { lastAttemptAt: new Date(Date.now() - 6 * 60_000) },
    });
    serve.etag = '"v2"';
    serve.body = fixture('apple');
    const third = await t.http.post(`/api/me/external-calendars/${cal.id}/refresh`).set(owner.auth);
    expect(third.status).toBe(200);
    expect(third.body.eventCount).toBe(2);
    const nov = await calendar(owner, '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    expect(nov.items.map((i) => i.title).sort()).toEqual(['Anniversary', 'Book club']);
    const ids = await t.prisma.externalEvent.findMany({
      where: { calendarId: cal.id },
      select: { uid: true },
    });
    expect(ids).toHaveLength(2);
    // Nobody else may refresh or change it.
    expect(
      (await t.http.post(`/api/me/external-calendars/${cal.id}/refresh`).set(member.auth)).status,
    ).toBe(404);
    expect(
      (
        await t.http
          .patch(`/api/me/external-calendars/${cal.id}`)
          .set(member.auth)
          .send({ name: 'x' })
      ).status,
    ).toBe(404);
  });

  it('keeps what it has when a refresh fails, waits longer each time, and switches off after two weeks', async () => {
    const cal = (await follow(owner)).body as ExternalCalendarDto;
    const due = () =>
      t.prisma.externalCalendar.update({
        where: { id: cal.id },
        data: { nextSyncAt: new Date(Date.now() - 1000) },
      });
    serve.fail = 'ics_unreachable';
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await due();
      expect(await external.refreshDue()).toBe(1);
      const row = await t.prisma.externalCalendar.findUniqueOrThrow({ where: { id: cal.id } });
      expect(row).toMatchObject({
        lastError: 'ics_unreachable',
        failureCount: i + 1,
        enabled: true,
      });
      waits.push(row.nextSyncAt.getTime() - Date.now());
    }
    expect(waits[1]!).toBeGreaterThan(waits[0]! * 1.5);
    expect(waits[2]!).toBeGreaterThan(waits[1]! * 1.5);
    expect(await t.prisma.externalEvent.count({ where: { calendarId: cal.id } })).toBe(3); // still there
    const listed = (await t.http.get('/api/me/external-calendars').set(owner.auth))
      .body as ExternalCalendarDto[];
    expect(listed[0]).toMatchObject({ lastError: 'ics_unreachable', eventCount: 3 });

    await t.prisma.externalCalendar.update({
      where: { id: cal.id },
      data: {
        failingSince: new Date(Date.now() - 15 * 86_400_000),
        nextSyncAt: new Date(Date.now() - 1000),
      },
    });
    await external.refreshDue();
    const off = await t.prisma.externalCalendar.findUniqueOrThrow({ where: { id: cal.id } });
    expect(off).toMatchObject({ enabled: false, disabledReason: 'failing_too_long' });
    const note = await t.prisma.notification.findFirstOrThrow({
      where: { userId: owner.id, kind: 'calendar_sync_off' },
    });
    expect(note).toMatchObject({ targetKind: 'ext_calendar', targetId: cal.id, summary: 'Work' });
    // Switched off: not read again, not shown.
    calls = [];
    await t.prisma.externalCalendar.update({
      where: { id: cal.id },
      data: { nextSyncAt: new Date(Date.now() - 1000) },
    });
    expect(await external.refreshDue()).toBe(0);
    expect(calls).toHaveLength(0);
    expect(
      (await calendar(owner, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')).items,
    ).toEqual([]);
    // Turning it on again starts afresh.
    serve.fail = undefined;
    const on = await t.http
      .patch(`/api/me/external-calendars/${cal.id}`)
      .set(owner.auth)
      .send({ enabled: true });
    expect(on.body).toMatchObject({
      enabled: true,
      lastError: null,
      disabledReason: null,
      failingSince: null,
    });
    expect(await external.refreshDue()).toBe(1);
    expect(
      (await calendar(owner, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')).items.length,
    ).toBeGreaterThan(0);
  });

  it('takes a calendar once even when two servers look at the same time, and reads at most four at once', async () => {
    serve.delay = 80;
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      serve.etag = undefined;
      const res = await follow(owner, { name: `C${i}` });
      if (res.status === 201) ids.push(res.body.id);
    }
    expect(ids).toHaveLength(8 - 0 > 10 ? 10 : 8);
    calls = [];
    peak = 0;
    await t.prisma.externalCalendar.updateMany({
      data: { nextSyncAt: new Date(Date.now() - 1000) },
    });
    const [a, b] = await Promise.all([external.refreshDue(), external.refreshDue()]);
    expect(a + b).toBe(8); // each calendar was taken by exactly one of them
    expect(calls).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('keeps ten per person, and the storage one person may use', async () => {
    serve.etag = undefined;
    for (let i = 0; i < 10; i++) expect((await follow(owner, { name: `C${i}` })).status).toBe(201);
    const eleventh = await follow(owner, { name: 'C10' });
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.message).toBe('too_many_calendars');
    expect((await follow(member)).status).toBe(201); // somebody else is not affected

    // The refusal for storage leaves what was kept.
    const cal = (await t.http.get('/api/me/external-calendars').set(member.auth))
      .body[0] as ExternalCalendarDto;
    const before = env.EXTERNAL_CALENDAR_MAX_MB;
    env.EXTERNAL_CALENDAR_MAX_MB = 0.0001;
    try {
      await t.prisma.externalCalendar.update({
        where: { id: cal.id },
        data: { nextSyncAt: new Date(Date.now() - 1000) },
      });
      await external.refreshDue();
    } finally {
      env.EXTERNAL_CALENDAR_MAX_MB = before;
    }
    const row = await t.prisma.externalCalendar.findUniqueOrThrow({ where: { id: cal.id } });
    expect(row.lastError).toBe('ics_quota');
    expect(await t.prisma.externalEvent.count({ where: { calendarId: cal.id } })).toBe(3);
  });

  it('lets the person rename, recolour, pause and delete', async () => {
    const cal = (await follow(owner)).body as ExternalCalendarDto;
    const patched = await t.http
      .patch(`/api/me/external-calendars/${cal.id}`)
      .set(owner.auth)
      .send({ name: 'Renamed', color: '#112233', syncEveryMinutes: 120 });
    expect(patched.body).toMatchObject({
      name: 'Renamed',
      color: '#112233',
      syncEveryMinutes: 120,
    });
    expect(
      (
        await t.http
          .patch(`/api/me/external-calendars/${cal.id}`)
          .set(owner.auth)
          .send({ syncEveryMinutes: 5 })
      ).status,
    ).toBe(400);
    await t.http
      .patch(`/api/me/external-calendars/${cal.id}`)
      .set(owner.auth)
      .send({ enabled: false });
    expect(
      (await calendar(owner, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')).items,
    ).toEqual([]);
    expect(
      (await t.http.delete(`/api/me/external-calendars/${cal.id}`).set(owner.auth)).status,
    ).toBe(204);
    expect(await t.prisma.externalEvent.count()).toBe(0);
  });

  it('does not stall on rules built to be expensive', async () => {
    serve.etag = undefined;
    const rule = (uid: string, rrule: string) =>
      `BEGIN:VEVENT\nUID:${uid}\nDTSTART:20270101T090000Z\nDTEND:20270101T100000Z\nSUMMARY:${uid}\nRRULE:${rrule}\nEND:VEVENT\n`;
    serve.body =
      'BEGIN:VCALENDAR\n' +
      rule('secondly', 'FREQ=SECONDLY') +
      rule('hourly', 'FREQ=HOURLY;COUNT=99999') +
      rule('never', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30') +
      rule('huge', 'FREQ=DAILY;COUNT=999999999;BYSECOND=1,2,3;BYHOUR=1,2,3') +
      rule('wide', 'FREQ=DAILY;INTERVAL=99999') +
      'END:VCALENDAR\n';
    const t0 = Date.now();
    const res = await follow(owner);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const window = await calendar(owner, '2027-01-01T00:00:00.000Z', '2028-12-30T00:00:00.000Z');
    expect(Date.now() - t0).toBeLessThan(5000);
    const titles = window.items.map((i) => i.title);
    expect(titles.filter((x) => x === 'secondly')).toHaveLength(1); // kept once, not repeated
    expect(titles.filter((x) => x === 'huge').length).toBeGreaterThan(300);
    expect(titles.filter((x) => x === 'never')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ import and export

const importFile = (who: Account, text: string, fields: Record<string, string> = {}) => {
  let req = t.http
    .post('/api/calendar/import')
    .set(who.auth)
    .attach('file', Buffer.from(text), { filename: 'calendar.ics', contentType: 'text/calendar' });
  for (const [k, v] of Object.entries({ mode: 'preview', ...fields })) req = req.field(k, v);
  return req;
};

const THREE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:imp-1@example.com',
  'DTSTART:20270301T090000Z',
  'DTEND:20270301T100000Z',
  'SUMMARY:Kickoff',
  'DESCRIPTION:<b>Hello</b> <script>steal()</script> team',
  'ATTENDEE;CN=Eve Evil:mailto:eve@evil.test',
  'ATTENDEE;CN=Bob:mailto:bob@evil.test',
  'ATTACH:https://evil.test/file.pdf',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:imp-2@example.com',
  'DTSTART;TZID=Europe/Lisbon:20270302T100000',
  'DTEND;TZID=Europe/Lisbon:20270302T110000',
  'SUMMARY:Weekly review',
  'RRULE:FREQ=WEEKLY;COUNT=4;BYHOUR=10',
  'EXDATE;TZID=Europe/Lisbon:20270309T100000',
  'BEGIN:VALARM',
  'TRIGGER:-PT30M',
  'ACTION:DISPLAY',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:imp-3@example.com',
  'DTSTART;VALUE=DATE:20270320',
  'DTEND;VALUE=DATE:20270321',
  'SUMMARY:Offsite',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

describe('import', () => {
  it('previews what is in a file, then creates only what was chosen, once', async () => {
    const personal = await personalSpaceId(t, owner.id);
    const users = await t.prisma.user.count();
    const preview = await importFile(owner, THREE);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const p = preview.body as IcsImportPreviewDto;
    expect(p).toMatchObject({
      mode: 'preview',
      spaceId: personal,
      skipped: 0,
      truncated: false,
      unsupported: [],
    });
    expect(
      p.items.map((i) => [
        i.uid,
        i.title,
        i.recurring,
        i.allDay,
        i.duplicate,
        i.simplified,
        i.exceptions,
      ]),
    ).toEqual([
      ['imp-1@example.com', 'Kickoff', false, false, false, false, 0],
      ['imp-2@example.com', 'Weekly review', true, false, false, true, 1],
      ['imp-3@example.com', 'Offsite', false, true, false, false, 0],
    ]);
    expect(await t.prisma.event.count()).toBe(0); // a preview creates nothing

    const first = await importFile(owner, THREE, {
      mode: 'commit',
      uids: JSON.stringify(['imp-1@example.com', 'imp-2@example.com']),
    });
    expect(first.body).toMatchObject({ mode: 'commit', created: 2, duplicates: 0 });
    const second = await importFile(owner, THREE, { mode: 'commit' });
    expect(second.body as IcsImportResultDto).toMatchObject({ created: 1, duplicates: 2 });
    const third = await importFile(owner, THREE, { mode: 'commit' });
    expect(third.body).toMatchObject({ created: 0, duplicates: 3 });
    expect(await t.prisma.event.count({ where: { spaceId: personal } })).toBe(3);
    expect(
      ((await importFile(owner, THREE)).body as IcsImportPreviewDto).items.every(
        (i) => i.duplicate,
      ),
    ).toBe(true);

    // The events are real events, with their series and exceptions.
    const win = await calendar(
      owner,
      '2027-03-01T00:00:00.000Z',
      '2027-04-01T00:00:00.000Z',
      'events,meetings',
    );
    expect(win.items.filter((i) => i.title === 'Weekly review').map((i) => i.start)).toEqual([
      '2027-03-02T10:00:00.000Z',
      '2027-03-16T10:00:00.000Z',
      '2027-03-23T10:00:00.000Z',
    ]);
    expect(win.items.find((i) => i.title === 'Offsite')).toMatchObject({
      allDay: true,
      start: '2027-03-20T00:00:00.000Z',
    });
    const kick = await t.prisma.event.findFirstOrThrow({
      where: { icsUid: 'imp-1@example.com' },
      include: { attendees: true },
    });
    expect(kick.ownerId).toBe(owner.id);
    expect(kick.kind).toBe('meeting');
    const weekly = await t.prisma.event.findFirstOrThrow({
      where: { icsUid: 'imp-2@example.com' },
      include: { reminders: true },
    });
    expect(weekly.rrule).toBe('FREQ=WEEKLY;COUNT=4');
    expect(weekly.reminders[0]!.minutes).toEqual([30]);
    expect(await usedBytes(t, owner.id)).toBeGreaterThan(0);
    expect(await t.prisma.user.count()).toBe(users);
  });

  it('keeps only text: no one is invited, no address kept, nothing attached, no markup', async () => {
    await importFile(owner, THREE, { mode: 'commit' });
    const kick = await t.prisma.event.findFirstOrThrow({
      where: { icsUid: 'imp-1@example.com' },
      include: { attendees: true },
    });
    expect(kick.attendees).toHaveLength(1); // the owner only
    expect(kick.attendees[0]).toMatchObject({ kind: 'user', subjectId: owner.id });
    expect(kick.description).toContain('Hello');
    expect(kick.description).toContain('Eve Evil, Bob');
    expect(kick.description).not.toMatch(/evil\.test|script|steal|<|ATTACH/i);
    expect(await t.prisma.user.count({ where: { email: { contains: 'evil.test' } } })).toBe(0);
    expect(await t.prisma.notification.count({ where: { userId: { not: owner.id } } })).toBe(0);
    expect(t.mail.sent.some((m) => m.to.includes('evil.test'))).toBe(false);
  });

  it('refuses what is not a calendar, an empty one, and no file', async () => {
    expect((await importFile(owner, 'hello')).body.message).toBe('ics_not_a_calendar');
    expect((await importFile(owner, '<html></html>')).status).toBe(422);
    expect((await importFile(owner, 'BEGIN:VCALENDAR\nEND:VCALENDAR\n')).body.message).toBe(
      'no_events',
    );
    expect(
      (await t.http.post('/api/calendar/import').set(owner.auth).field('mode', 'preview')).body
        .message,
    ).toBe('no_file');
    expect(
      (await t.http.post('/api/calendar/import').attach('file', Buffer.from(THREE), 'a.ics'))
        .status,
    ).toBe(401);
    // A file over the limit is refused before it is read.
    const big = await importFile(owner, 'BEGIN:VCALENDAR\n' + 'X'.repeat(5 * 1024 * 1024 + 10));
    expect(big.status).toBe(413);
  });

  it('counts the parts that are not events, and the ones that were broken', async () => {
    const text = THREE.replace(
      'END:VCALENDAR',
      'BEGIN:VTODO\r\nUID:todo\r\nSUMMARY:Task\r\nEND:VTODO\r\nBEGIN:VEVENT\r\nUID:broken\r\nSUMMARY:No start\r\nEND:VEVENT\r\nEND:VCALENDAR',
    );
    const p = (await importFile(owner, text)).body as IcsImportPreviewDto;
    expect(p.unsupported).toEqual([{ component: 'VTODO', count: 1 }]);
    expect(p.skipped).toBe(1);
    expect(p.items).toHaveLength(3);
  });

  it('puts events in a team space only for somebody who may create meetings there', async () => {
    const team = await newTeam([member]);
    expect((await importFile(outsider, THREE, { spaceId: team.spaceId })).status).toBe(404);
    expect((await importFile(member, THREE, { spaceId: team.spaceId })).status).toBe(403);
    expect(
      (await importFile(member, THREE, { spaceId: team.spaceId, mode: 'commit' })).status,
    ).toBe(403);
    expect(await t.prisma.event.count({ where: { spaceId: team.spaceId } })).toBe(0);
    await giveRole(team, member, P.CREATE_MEETINGS);
    const ok = await importFile(member, THREE, { spaceId: team.spaceId, mode: 'commit' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ created: 3, spaceId: team.spaceId });
    expect(
      await t.prisma.event.count({ where: { spaceId: team.spaceId, ownerId: member.id } }),
    ).toBe(3);
    // Nobody else's personal space.
    const theirs = await personalSpaceId(t, owner.id);
    expect((await importFile(member, THREE, { spaceId: theirs })).status).toBe(404);
  });

  it('takes the repeat rules it can and says when it had to simplify', async () => {
    const text = [
      'BEGIN:VCALENDAR',
      ...[
        'secondly:FREQ=SECONDLY',
        'many:FREQ=DAILY;COUNT=999999999',
        'ok:FREQ=MONTHLY;BYDAY=2TU',
      ].flatMap((x) => {
        const [uid, rule] = x.split(':');
        return [
          'BEGIN:VEVENT',
          `UID:${uid}`,
          'DTSTART:20270301T090000Z',
          'DTEND:20270301T100000Z',
          `SUMMARY:${uid}`,
          `RRULE:${rule}`,
          'END:VEVENT',
        ];
      }),
      'END:VCALENDAR',
    ].join('\n');
    const t0 = Date.now();
    const p = (await importFile(owner, text)).body as IcsImportPreviewDto;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(p.items.map((i) => [i.uid, i.recurring, i.simplified])).toEqual([
      ['secondly', false, true],
      ['many', true, true],
      ['ok', true, false],
    ]);
  });
});

describe('export', () => {
  it('gives one event as a file to anybody who can see it, and 404 to anybody else', async () => {
    const team = await newTeam([member]);
    const ev = await newEvent(owner, team.spaceId, {
      title: 'Roadmap, Q1',
      visibility: 'attendees',
    });
    const own = await t.http.get(`/api/events/${ev.id}.ics`).set(owner.auth);
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(own.headers['content-disposition']).toMatch(/^attachment; filename="Roadmap-Q1\.ics"/);
    expect(own.text).toContain('SUMMARY:Roadmap\\, Q1');
    expect(own.text).toContain(`UID:${ev.id}@`);
    expect((await t.http.get(`/api/events/${ev.id}.ics`).set(member.auth)).status).toBe(404); // not on it, not shared with the space
    expect((await t.http.get(`/api/events/${ev.id}.ics`).set(outsider.auth)).status).toBe(404);
    expect((await t.http.get(`/api/events/${ev.id}.ics`)).status).toBe(401);
    expect((await t.http.get(`/api/events/${uuid()}.ics`).set(owner.auth)).status).toBe(404);
    // The ordinary route is still there.
    expect((await t.http.get(`/api/events/${ev.id}`).set(owner.auth)).status).toBe(200);
  });

  it('exports a range of the person’s own calendar', async () => {
    const personal = await personalSpaceId(t, owner.id);
    await newEvent(owner, personal, { title: 'In range' });
    await newEvent(owner, personal, {
      title: 'Out of range',
      startAt: '2028-03-15T09:00:00.000Z',
      endAt: '2028-03-15T10:00:00.000Z',
    });
    await newEvent(member, await personalSpaceId(t, member.id), { title: 'Not mine' });
    const res = await t.http
      .get('/api/calendar/export')
      .set(owner.auth)
      .query({ from: '2027-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text).toContain('SUMMARY:In range');
    expect(res.text).not.toContain('Out of range');
    expect(res.text).not.toContain('Not mine');
    expect(
      (await t.http.get('/api/calendar/export').query({ from: '2027-01-01T00:00:00Z' })).status,
    ).toBe(401);
    expect(
      (
        await t.http
          .get('/api/calendar/export')
          .set(owner.auth)
          .query({ from: '2027-01-01T00:00:00Z', to: '2020-01-01T00:00:00Z' })
      ).status,
    ).toBe(422);
  });

  it('writes a file that reads back as the same events', async () => {
    const personal = await personalSpaceId(t, owner.id);
    await importFile(owner, THREE, { mode: 'commit' });
    const out = await t.http
      .get('/api/calendar/export')
      .set(owner.auth)
      .query({ from: '2027-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' });
    // Reading our own export through the importer finds all three (as duplicates, because it is the same space).
    const preview = (await importFile(owner, out.text)).body as IcsImportPreviewDto;
    expect(preview.items.map((i) => i.title).sort()).toEqual([
      'Kickoff',
      'Offsite',
      'Weekly review',
    ]);
    expect(preview.items.find((i) => i.title === 'Weekly review')).toMatchObject({
      recurring: true,
      exceptions: 1,
    });
    expect(await t.prisma.event.count({ where: { spaceId: personal } })).toBe(3);
  });
});
