// End-to-end: calendar and meetings. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  launch,
  register,
  sql,
  startStack,
  uniqueEmail,
  verify,
  waitForOfflineReady,
} from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('caladmin');

const P = {
  CREATE_MEETINGS: 1n << 30n,
  MANAGE_MEETINGS: 1n << 31n,
  ADD_TO_MEMBER_CALENDARS: 1n << 32n,
};

let stack;
let browser;
let base;
let adminOnce;

before(async () => {
  stack = await startStack({ env: { ADMIN_EMAILS: ADMIN_EMAIL } });
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await (await adminOnce)?.close();
  await browser?.close();
  await stack?.stop();
});

// A person in Lisbon, so a "09:00" on the screen is 09:00 local (08:00 UTC in summer time).
async function device() {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    timezoneId: 'Europe/Lisbon',
    locale: 'en-GB',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on(
    'console',
    (m) =>
      /Content Security Policy|violates the following/i.test(m.text()) &&
      problems.push(m.text().slice(0, 200)),
  );
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  return { ctx, page, problems, close: async () => ctx.close() };
}

async function account(name, wanted) {
  const d = await device();
  const { email } = await register(d.page, base, { name, ...(wanted ? { email: wanted } : {}) });
  await verify(d.page, email);
  await d.page.goto(`${base}/app`);
  await d.page.waitForSelector('app-rail');
  const id = (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;
  return { ...d, email, id, name };
}

const getAdmin = () => (adminOnce ??= account('The Admin', ADMIN_EMAIL));

async function createTeam(name, owner) {
  const admin = await getAdmin();
  await admin.page.goto(`${base}/app/admin`);
  await admin.page.waitForSelector('[data-admin-teams]');
  await admin.page.fill('input[name=teamName]', name);
  await admin.page.fill('input[name=teamOwner]', owner.email);
  await admin.page.click('[data-create-team]');
  await admin.page.locator(`[data-team-row="${name}"]`).waitFor();
  const [row] = await sql(
    'SELECT t.id, s.id AS spaceId FROM `Team` t JOIN `Space` s ON s.teamId = t.id WHERE t.name = ?',
    [name],
  );
  return { id: row.id, spaceId: row.spaceId };
}

const joinTeam = (team, who) =>
  sql('INSERT INTO `TeamMember` (teamId, userId, joinedAt) VALUES (?, ?, NOW(3))', [
    team.id,
    who.id,
  ]);

/** Calls the API as the signed-in person of that page. */
async function api(page, method, path, body) {
  return page.evaluate(
    async ([m, p, b]) => {
      const refresh = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'X-Requested-With': 'os_planner' },
      });
      const { accessToken } = await refresh.json();
      const res = await fetch(p, {
        method: m,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(b ? { 'Content-Type': 'application/json' } : {}),
        },
        body: b ? JSON.stringify(b) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, path, body ?? null],
  );
}

/** A role holding `bits` (a bigint) given to `who`, made by the owner of the team. */
async function giveRole(owner, team, who, bits, name = `Role ${randomUUID().slice(0, 6)}`) {
  const made = await api(owner.page, 'POST', `/api/teams/${team.id}/roles`, {
    name,
    permissions: String(bits),
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  for (const person of [].concat(who)) {
    const put = await api(
      owner.page,
      'PUT',
      `/api/teams/${team.id}/members/${person.id}/roles/${made.body.id}`,
    );
    assert.equal(put.status, 204, JSON.stringify(put.body));
  }
  return made.body.id;
}

async function apiEvent(page, spaceId, body) {
  const res = await api(page, 'POST', '/api/events', {
    id: randomUUID(),
    spaceId,
    kind: 'meeting',
    startAt: '2027-03-16T14:00:00.000Z',
    endAt: '2027-03-16T15:00:00.000Z',
    timezone: 'Europe/Lisbon',
    ...body,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const until = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 250));
  }
};

const open = async (who, view, day, extra = '') => {
  await who.page.goto(`${base}/app/calendar?view=${view}&d=${day}${extra}`);
  await who.page.waitForSelector('[data-calendar]');
};
const chip = (page, title, day) =>
  page.locator(`${day ? `[data-day="${day}"] ` : ''}[data-title="${title}"]`);
const inCol = (page, day, title) => page.locator(`[data-col="${day}"] [data-title="${title}"]`);
const eventRow = async (title) =>
  (
    await sql(
      "SELECT *, DATE_FORMAT(startAt, '%Y-%m-%dT%H:%i:%s.000Z') AS startIso FROM `Event` WHERE title = ? AND deletedAt IS NULL",
      [title],
    )
  )[0];

/** Drags with the mouse from the middle of an element by (dx, dy) pixels. */
async function dragBy(page, locator, dx, dy) {
  const b = await locator.boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + Math.min(b.height / 2, 12);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

describe('calendar', () => {
  test(
    'month, week, day and agenda show a meeting and a task on their days; moving a meeting is seen live, and a person who may not change it cannot',
    T,
    async () => {
      const owner = await account('Olivia Owner');
      const member = await account('Mia Member');
      const team = await createTeam('Calendars', owner);
      await joinTeam(team, member);

      await apiEvent(owner.page, team.spaceId, {
        title: 'Planning',
        attendees: [{ kind: 'user', subjectId: member.id }],
      });
      // a task of the member with a due date on the 17th
      const board = randomUUID();
      assert.equal(
        (
          await api(owner.page, 'POST', `/api/spaces/${team.spaceId}/boards`, {
            id: board,
            name: 'Sprint',
            position: 'a0',
          })
        ).status,
        201,
      );
      const columnId = (await api(owner.page, 'GET', `/api/boards/${board}`)).body.columns[0].id;
      assert.equal(
        (
          await api(owner.page, 'POST', `/api/boards/${board}/tasks`, {
            id: randomUUID(),
            columnId,
            position: 'a0',
            title: 'Ship it',
            dueAt: '2027-03-17T12:00:00.000Z',
            assigneeIds: [member.id],
          })
        ).status,
        201,
      );

      await open(member, 'month', '2027-03-15');
      await chip(member.page, 'Planning', '2027-03-16').waitFor();
      await chip(member.page, 'Ship it', '2027-03-17').waitFor();
      assert.equal(await chip(member.page, 'Planning', '2027-03-17').count(), 0);

      // the four views
      await member.page.click('[data-view-btn=week]');
      await member.page.waitForSelector('[data-view=week]');
      assert.equal(
        await inCol(member.page, '2027-03-16', 'Planning').getAttribute('data-start'),
        '2027-03-16T14:00:00.000Z',
      );
      assert.match(await inCol(member.page, '2027-03-16', 'Planning').innerText(), /14:00/); // Lisbon in March 2027 is still UTC+0
      await inCol(member.page, '2027-03-17', 'Ship it').waitFor();
      await member.page.click('[data-view-btn=day]');
      await member.page.waitForSelector('[data-view=day]');
      await member.page.click('[data-view-btn=agenda]');
      await member.page.waitForSelector('[data-view=agenda]');
      await member.page.locator('[data-agenda-day="2027-03-16"] [data-title="Planning"]').waitFor();
      await member.page.locator('[data-agenda-day="2027-03-17"] [data-title="Ship it"]').waitFor();
      // the keyboard: m / w / d / a, t, arrows
      await member.page.keyboard.press('w');
      await member.page.waitForSelector('[data-view=week]');
      await member.page.keyboard.press('ArrowRight');
      await member.page.waitForSelector('[data-col="2027-03-22"]');
      await member.page.keyboard.press('ArrowLeft');
      await member.page.waitForSelector('[data-col="2027-03-16"]');

      // the person who may not change it cannot move it
      await open(member, 'week', '2027-03-16');
      const mine = inCol(member.page, '2027-03-16', 'Planning');
      await mine.waitFor();
      await dragBy(member.page, mine, 0, 48);
      await member.page.waitForTimeout(600);
      assert.equal(await mine.getAttribute('data-start'), '2027-03-16T14:00:00.000Z');

      // the owner moves it an hour later; the member, who has the week open, sees it without reloading
      await open(owner, 'week', '2027-03-16');
      const theirs = inCol(owner.page, '2027-03-16', 'Planning');
      await theirs.waitFor();
      await dragBy(owner.page, theirs, 0, 48);
      await until(
        async () => (await eventRow('Planning'))?.startIso === '2027-03-16T15:00:00.000Z',
      );
      await member.page.waitForFunction(
        () =>
          document
            .querySelector('[data-col="2027-03-16"] [data-title="Planning"]')
            ?.getAttribute('data-start') === '2027-03-16T15:00:00.000Z',
        null,
        { timeout: 30_000 },
      );
      assert.deepEqual([...owner.problems, ...member.problems], []);
      await owner.close();
      await member.close();
    },
  );

  test(
    'a person with ADD_TO_MEMBER_CALENDARS invites a person and a role; they see who added it, and declining takes it off the agenda; without the permission the picker offers nobody else',
    T,
    async () => {
      const owner = await account('Olivia Owner');
      const alice = await account('Alice Planner');
      const bob = await account('Bob Invitee');
      const carol = await account('Carol Reviewer');
      const dave = await account('Dave Plain');
      const team = await createTeam('Invitations', owner);
      for (const p of [alice, bob, carol, dave]) await joinTeam(team, p);
      await giveRole(owner, team, alice, P.CREATE_MEETINGS | P.ADD_TO_MEMBER_CALENDARS);
      const reviewers = await giveRole(owner, team, carol, 0n, 'Reviewers');
      await giveRole(owner, team, dave, P.CREATE_MEETINGS);

      // Alice makes the meeting in the dialog, naming Bob and the role
      await open(alice, 'week', '2027-03-16');
      await alice.page.waitForSelector(`[data-space-toggle="${team.spaceId}"]`);
      await alice.page.click('[data-action=new-event]');
      await alice.page.waitForSelector('[data-event-dialog]');
      await alice.page.selectOption('[data-field=space]', team.spaceId);
      await alice.page.fill('[data-field=title]', 'Design review');
      await alice.page.fill('[data-field=start-date]', '2027-03-16');
      await alice.page.fill('[data-field=start-time]', '11:00');
      await alice.page.fill('[data-field=end-time]', '12:00');
      await alice.page.waitForSelector('[data-attendee-picker] [data-person]');
      await alice.page.check(`[data-person="${bob.id}"]`);
      await alice.page.check(`[data-role="${reviewers}"]`);
      await alice.page.click('[data-action=save-event]');
      await alice.page.waitForSelector('mat-dialog-container', { state: 'detached' });
      await until(() => eventRow('Design review'));
      const [{ id: eventId }] = await sql("SELECT id FROM `Event` WHERE title = 'Design review'");
      const people = await sql(
        'SELECT kind, subjectId FROM `EventAttendee` WHERE eventId = ? ORDER BY kind',
        [eventId],
      );
      assert.deepEqual(people.map((p) => p.kind).sort(), ['role', 'user', 'user']);

      // Bob and a member of the role see it, and who added it
      for (const [who, via] of [
        [bob, 'user'],
        [carol, 'role'],
      ]) {
        await open(who, 'week', '2027-03-16');
        const e = inCol(who.page, '2027-03-16', 'Design review');
        await e.waitFor();
        await e.click();
        await who.page.waitForSelector('[data-rsvp-bar]');
        assert.match(
          await who.page.locator('[data-who-added]').first().innerText(),
          /Alice Planner/,
        );
        assert.equal(await who.page.locator('[data-my-status]').innerText(), 'Not answered', via);
        await who.page.click('[data-action=close]');
        await who.page.waitForSelector('mat-dialog-container', { state: 'detached' });
      }
      // Bob declines: it leaves his agenda, the audit trail stays
      await bob.page.locator('[data-col="2027-03-16"] [data-title="Design review"]').click();
      await bob.page.click('[data-rsvp=declined]');
      await bob.page.click('[data-action=close]');
      await bob.page.waitForSelector('mat-dialog-container', { state: 'detached' });
      await bob.page.waitForFunction(() => !document.querySelector('[data-title="Design review"]'));
      await until(
        async () =>
          (
            await sql(
              "SELECT status FROM `EventAttendee` WHERE eventId = ? AND subjectId = ? AND kind = 'user'",
              [eventId, bob.id],
            )
          )[0]?.status === 'declined',
      );
      assert.equal(
        (await sql('SELECT deletedAt FROM `Event` WHERE id = ?', [eventId]))[0].deletedAt,
        null,
      );
      // Carol's answer is her own row
      await carol.page.locator('[data-col="2027-03-16"] [data-title="Design review"]').click();
      await carol.page.click('[data-rsvp=accepted]');
      await until(
        async () =>
          (
            await sql(
              "SELECT status FROM `EventAttendee` WHERE eventId = ? AND subjectId = ? AND kind = 'user'",
              [eventId, carol.id],
            )
          )[0]?.status === 'accepted',
      );

      // Dave may make meetings but not name others: nobody to pick
      await open(dave, 'week', '2027-03-16');
      await dave.page.waitForSelector(`[data-space-toggle="${team.spaceId}"]`);
      await dave.page.click('[data-action=new-event]');
      await dave.page.waitForSelector('[data-event-dialog]');
      await dave.page.selectOption('[data-field=space]', team.spaceId);
      await dave.page.waitForSelector('[data-attendee-picker] [data-only-me]');
      assert.equal(await dave.page.locator('[data-person]').count(), 0);
      assert.equal(await dave.page.locator('[data-role]').count(), 0);
      for (const p of [owner, alice, bob, carol, dave]) assert.deepEqual(p.problems, []);
      for (const p of [owner, alice, bob, carol, dave]) await p.close();
    },
  );

  test(
    'a weekly meeting: change one occurrence, cancel another, and it stays at 09:00 across the change of summer time',
    T,
    async () => {
      const owner = await account('Olivia Owner');
      const team = await createTeam('Series', owner);
      await apiEvent(owner.page, team.spaceId, {
        title: 'Standup',
        startAt: '2027-03-15T09:00:00.000Z',
        endAt: '2027-03-15T09:30:00.000Z',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        visibility: 'space',
      });

      await open(owner, 'month', '2027-03-15');
      for (const day of ['2027-03-15', '2027-03-22', '2027-03-29', '2027-04-05'])
        await chip(owner.page, 'Standup', day).waitFor();

      // change the title of the 22nd only
      await chip(owner.page, 'Standup', '2027-03-22').click();
      await owner.page.waitForSelector('[data-event-dialog]');
      await owner.page.fill('[data-field=title]', 'Standup (retro)');
      await owner.page.click('[data-action=save-event]');
      await owner.page.click('[data-scope=this]');
      await owner.page.click('[data-action=scope-ok]');
      await owner.page.waitForSelector('mat-dialog-container', { state: 'detached' });
      await chip(owner.page, 'Standup (retro)', '2027-03-22').waitFor();
      assert.equal(await chip(owner.page, 'Standup', '2027-03-22').count(), 0);
      await chip(owner.page, 'Standup', '2027-03-29').waitFor();
      await until(
        async () =>
          (await sql('SELECT * FROM `EventException` WHERE kind = ?', ['override'])).length === 1,
      );

      // cancel the 5th of April only
      await chip(owner.page, 'Standup', '2027-04-05').click();
      await owner.page.waitForSelector('[data-event-dialog]');
      await owner.page.click('[data-action=cancel-event]');
      await owner.page.click('[data-scope=this]');
      await owner.page.click('[data-action=scope-ok]');
      await owner.page.waitForSelector('mat-dialog-container', { state: 'detached' });
      await owner.page.waitForFunction(
        () => !document.querySelector('[data-day="2027-04-05"] [data-title="Standup"]'),
      );
      await chip(owner.page, 'Standup', '2027-03-29').waitFor();
      await until(
        async () =>
          (await sql('SELECT * FROM `EventException` WHERE kind = ?', ['cancelled'])).length === 1,
      );
      assert.equal(
        (
          await sql('SELECT COUNT(*) AS n FROM `Event` WHERE title = ? AND deletedAt IS NULL', [
            'Standup',
          ])
        )[0].n,
        1n,
      );

      // 09:00 Lisbon on the 22nd is 09:00 UTC, on the 29th (summer time) it is 08:00 UTC: on the screen both are 09:00
      await open(owner, 'week', '2027-03-29');
      const after = inCol(owner.page, '2027-03-29', 'Standup');
      await after.waitFor();
      assert.equal(await after.getAttribute('data-start'), '2027-03-29T08:00:00.000Z');
      assert.match(await after.innerText(), /09:00/);
      await open(owner, 'week', '2027-03-22');
      const before = inCol(owner.page, '2027-03-22', 'Standup (retro)');
      await before.waitFor();
      assert.equal(await before.getAttribute('data-start'), '2027-03-22T09:00:00.000Z');
      assert.match(await before.innerText(), /09:00/);
      assert.deepEqual(owner.problems, []);
      await owner.close();
    },
  );

  test(
    'offline: the agenda comes from this device, an event made offline appears after reconnecting, and an answer given offline is applied',
    T,
    async () => {
      const owner = await account('Olivia Owner');
      const member = await account('Mia Member');
      const team = await createTeam('Offline', owner);
      await joinTeam(team, member);
      await apiEvent(owner.page, team.spaceId, {
        title: 'All hands',
        attendees: [{ kind: 'user', subjectId: member.id }],
      });

      await open(member, 'agenda', '2027-03-15');
      await member.page
        .locator('[data-agenda-day="2027-03-16"] [data-title="All hands"]')
        .waitFor();
      await member.page.waitForTimeout(1500); // a sync cycle finishes
      await waitForOfflineReady(member.page);
      await member.ctx.setOffline(true);
      await member.page.reload();
      await member.page.waitForSelector('[data-calendar]');
      await member.page
        .locator('[data-agenda-day="2027-03-16"] [data-title="All hands"]')
        .waitFor();

      // make a personal event offline
      await member.page.click('[data-action=new-event]');
      await member.page.waitForSelector('[data-event-dialog]');
      await member.page.fill('[data-field=title]', 'Dentist');
      await member.page.fill('[data-field=start-date]', '2027-03-18');
      await member.page.fill('[data-field=start-time]', '16:30');
      await member.page.fill('[data-field=end-time]', '17:00');
      await member.page.click('[data-action=save-event]');
      await member.page.waitForSelector('mat-dialog-container', { state: 'detached' });
      await member.page.locator('[data-agenda-day="2027-03-18"] [data-title="Dentist"]').waitFor();
      // answer the invitation offline
      await member.page.locator('[data-agenda-day="2027-03-16"] [data-title="All hands"]').click();
      await member.page.waitForSelector('[data-rsvp-bar]');
      await member.page.click('[data-rsvp=accepted]');
      await member.page.waitForFunction(
        () => document.querySelector('[data-my-status]')?.textContent?.trim() === 'Going',
      );
      await member.page.click('[data-action=close]');
      assert.equal(await eventRow('Dentist'), undefined);

      // back online: both reach the server
      await member.ctx.setOffline(false);
      await member.page.evaluate(() => {
        window.dispatchEvent(new Event('online'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const dentist = await until(() => eventRow('Dentist'), 40_000);
      assert.equal(dentist.startIso, '2027-03-18T16:30:00.000Z');
      const [{ id }] = await sql("SELECT id FROM `Event` WHERE title = 'All hands'");
      await until(
        async () =>
          (
            await sql(
              "SELECT status FROM `EventAttendee` WHERE eventId = ? AND subjectId = ? AND kind = 'user'",
              [id, member.id],
            )
          )[0]?.status === 'accepted',
        40_000,
      );
      // the author sees the answer
      await open(owner, 'agenda', '2027-03-15');
      await owner.page.locator('[data-agenda-day="2027-03-16"] [data-title="All hands"]').click();
      await owner.page.waitForSelector('[data-attendees]');
      await owner.page.waitForSelector(`[data-attendee="${member.id}"][data-status="accepted"]`);
      assert.deepEqual([...owner.problems, ...member.problems], []);
      await owner.close();
      await member.close();
    },
  );
});
