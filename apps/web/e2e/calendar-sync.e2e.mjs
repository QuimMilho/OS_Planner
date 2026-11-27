// End-to-end: ICS feeds, followed calendars and import (phase 14). The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { launch, register, sql, startStack, uniqueEmail, verify } from './harness.mjs';

const T = { timeout: 300_000 };

let stack;
let browser;
let base;
let fixture;
let fixtureHits = 0;
let fixtureBody = '';

const ics = (events) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//e2e//EN',
    ...events.flat(),
    'END:VCALENDAR',
    '',
  ].join('\r\n');
const allDay = (uid, title, date, extra = []) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  `DTSTART;VALUE=DATE:${date}`,
  `DTEND;VALUE=DATE:${String(Number(date) + 1)}`,
  `SUMMARY:${title}`,
  ...extra,
  'END:VEVENT',
];

before(async () => {
  // A calendar server of the test's own, on this machine. The app server refuses private addresses unless the operator lists one.
  fixture = createServer((req, res) => {
    fixtureHits++;
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
    res.end(fixtureBody);
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = fixture.address().port;
  stack = await startStack({
    env: { ICS_PRIVATE_ALLOWLIST: `127.0.0.1:${port}`, ICS_ALLOW_HTTP: 'true' },
  });
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await stack?.stop();
  fixture?.closeAllConnections();
  await new Promise((resolve) => fixture?.close(() => resolve()));
});

const fixtureUrl = (path = '/work.ics') => `http://127.0.0.1:${fixture.address().port}${path}`;

async function account(name) {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    timezoneId: 'Europe/Lisbon',
    locale: 'en-GB',
    acceptDownloads: true,
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
  const { email } = await register(page, base, { name, email: uniqueEmail('ics') });
  await verify(page, email);
  await page.goto(`${base}/app`);
  await page.waitForSelector('app-rail');
  const id = (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;
  return { ctx, page, problems, email, id, close: () => ctx.close() };
}

const openCalendar = async (who, day = '2027-03-15', view = 'month') => {
  await who.page.goto(`${base}/app/calendar?view=${view}&d=${day}`);
  await who.page.waitForSelector('[data-calendar]');
};
const openSync = async (who) => {
  await who.page.goto(`${base}/app/settings`);
  await who.page.waitForSelector('[data-sync-feeds]');
};
const until = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 250));
  }
};
const confirm = (page) => page.click('mat-dialog-container button.danger');

async function newEvent(who, title, date, from, to) {
  await who.page.click('[data-action=new-event]');
  await who.page.waitForSelector('[data-event-dialog]');
  await who.page.fill('[data-field=title]', title);
  await who.page.fill('[data-field=start-date]', date);
  await who.page.fill('[data-field=start-time]', from);
  await who.page.fill('[data-field=end-time]', to);
  await who.page.click('[data-action=save-event]');
  await who.page.waitForSelector('mat-dialog-container', { state: 'detached' });
  await until(
    async () =>
      (await sql('SELECT id FROM `Event` WHERE title = ? AND deletedAt IS NULL', [title]))[0],
  );
}

describe('calendar sync', () => {
  test(
    'a private address other apps can follow: what is made in the app is in the file, a renewed address kills the old one',
    T,
    async () => {
      const who = await account('Fiona Feed');
      await openCalendar(who);
      await newEvent(who, 'Dentist', '2027-03-18', '16:30', '17:00');

      await openSync(who);
      await who.page.fill('[data-feed-name-input]', 'Phone');
      await who.page.click('[data-feed-create]');
      await who.page.waitForSelector('[data-feed-secret]');
      const url = await who.page.inputValue('[data-feed-url]');
      assert.match(url, /\/api\/feeds\/[A-Za-z0-9_-]{43}\.ics$/);
      await who.page.waitForSelector('[data-feed-qr]');
      assert.match(await who.page.getAttribute('[data-feed-qr]', 'src'), /^data:image\//);
      await who.page.locator('[data-feed-row][data-feed-name="Phone"]').waitFor();

      // what a calendar app would do: a plain request, no cookies
      const first = await fetch(url);
      assert.equal(first.status, 200);
      assert.match(first.headers.get('content-type'), /^text\/calendar/);
      const text = await first.text();
      assert.match(text, /SUMMARY:Dentist/);
      assert.match(text, /DTSTART;TZID=Europe\/Lisbon:20270318T163000/);
      assert.match(text, /BEGIN:VALARM/);
      assert.equal(
        (await fetch(url, { headers: { 'If-None-Match': first.headers.get('etag') } })).status,
        304,
      );

      // a new event shows in the file
      await openCalendar(who);
      await newEvent(who, 'Review', '2027-03-19', '10:00', '11:00');
      const second = await fetch(url);
      assert.match(await second.text(), /SUMMARY:Review/);
      assert.notEqual(second.headers.get('etag'), first.headers.get('etag'));

      // leaving out meetings takes them out of the file
      await openSync(who);
      await who.page.locator('[data-feed-row] [data-feed-include=meetings]').uncheck();
      await until(async () => !(await (await fetch(url)).text()).includes('SUMMARY:Review'));

      // renewing: the old address is gone, the new one works
      await who.page.click('[data-feed-rotate]');
      await confirm(who.page);
      await who.page.waitForSelector('[data-feed-secret]');
      const renewed = await who.page.inputValue('[data-feed-url]');
      assert.notEqual(renewed, url);
      assert.equal((await fetch(url)).status, 404);
      assert.equal((await fetch(renewed)).status, 200);
      assert.equal((await fetch(`${base}/api/feeds/${'A'.repeat(43)}.ics`)).status, 404);

      // deleting it
      await who.page.click('[data-feed-delete]');
      await confirm(who.page);
      await who.page.locator('[data-feed-empty]').waitFor();
      assert.equal((await fetch(renewed)).status, 404);
      assert.deepEqual(who.problems, []);
      await who.close();
    },
  );

  test(
    'a calendar from elsewhere: its events show muted and read only, a refresh brings the changes, and an address inside is refused kindly',
    T,
    async () => {
      const who = await account('Eva External');
      fixtureBody = ics([
        allDay('lunch@fixture', 'Team lunch', '20270317', [
          'LOCATION:Cantina',
          'URL:https://example.com/lunch',
        ]),
      ]);

      await openSync(who);
      await who.page.fill('[data-ext-name-input]', 'Work');
      await who.page.fill('[data-ext-url-input]', fixtureUrl());
      await who.page.click('[data-ext-add]');
      const row = who.page.locator('[data-ext-row][data-ext-name="Work"]');
      await row.waitFor();
      assert.match(await row.locator('[data-ext-status]').innerText(), /Up to date/);
      assert.match(await row.innerText(), /1 events/);

      // on the calendar: muted, with a lock, in its own colour; opening shows what it is
      await openCalendar(who);
      const chip = who.page.locator('[data-day="2027-03-17"] [data-title="Team lunch"]');
      await chip.waitFor();
      assert.equal(await chip.getAttribute('data-source'), 'external');
      assert.ok((await chip.getAttribute('class')).includes('external'));
      await chip.locator('mat-icon', { hasText: 'lock' }).waitFor();
      await chip.click();
      await who.page.waitForSelector('[data-external-title]');
      assert.match(await who.page.locator('mat-dialog-container').innerText(), /read only/i);
      assert.match(await who.page.locator('mat-dialog-container').innerText(), /Cantina/);
      assert.equal(
        await who.page.locator('[data-external-open]').getAttribute('href'),
        'https://example.com/lunch',
      );
      await who.page.keyboard.press('Escape');
      await who.page.waitForSelector('mat-dialog-container', { state: 'detached' });
      // it cannot be dragged: the day stays the same after a try
      const box = await chip.boundingBox();
      await who.page.mouse.move(box.x + 10, box.y + 8);
      await who.page.mouse.down();
      await who.page.mouse.move(box.x + 200, box.y + 8, { steps: 6 });
      await who.page.mouse.up();
      await who.page
        .locator('mat-dialog-container')
        .waitFor({ state: 'detached' })
        .catch(() => undefined);
      assert.equal(
        await who.page.locator('[data-day="2027-03-17"] [data-title="Team lunch"]').count(),
        1,
      );

      // the switch in the side bar hides it
      const hits = fixtureHits;
      const toggle = who.page.locator('[data-ext-toggle]');
      await toggle.uncheck();
      await who.page.locator('[data-title="Team lunch"]').waitFor({ state: 'detached' });
      await toggle.check();
      await who.page.locator('[data-title="Team lunch"]').waitFor();
      assert.equal(fixtureHits, hits); // looking at it again does not ask the other server

      // the other side changes; "refresh now" brings it
      fixtureBody = ics([allDay('lunch@fixture', 'Team lunch (moved)', '20270318')]);
      await openSync(who);
      await who.page.locator('[data-ext-row][data-ext-name="Work"] [data-ext-refresh]').click();
      await until(() => fixtureHits > hits);
      await openCalendar(who);
      await who.page.locator('[data-day="2027-03-18"] [data-title="Team lunch (moved)"]').waitFor();
      assert.equal(await who.page.locator('[data-title="Team lunch"]').count(), 0);

      // another refresh straight away is too soon
      await openSync(who);
      await who.page.locator('[data-ext-row] [data-ext-refresh]').click();
      await who.page.waitForSelector('.snack-error');
      assert.match(await who.page.locator('.snack-error').innerText(), /refreshed a moment ago/);

      // an address inside is refused with a friendly message, and nothing is saved
      for (const bad of [
        'http://169.254.169.254/latest/meta-data/',
        `http://127.0.0.1:${Number(fixture.address().port) + 1}/a.ics`,
        'file:///etc/passwd',
      ]) {
        await who.page.fill('[data-ext-name-input]', 'Sneaky');
        await who.page.fill('[data-ext-url-input]', bad);
        await who.page.click('[data-ext-add]');
        await who.page.waitForSelector('[data-ext-add-error]');
        const msg = await who.page.locator('[data-ext-add-error]').innerText();
        assert.match(
          msg,
          bad.startsWith('file:')
            ? /not an address this calendar can read/
            : /inside a private network/,
        );
      }
      assert.equal(
        (await sql('SELECT COUNT(*) AS n FROM `ExternalCalendar` WHERE userId = ?', [who.id]))[0].n,
        1n,
      );

      // removing it removes its events
      await who.page.locator('[data-ext-row][data-ext-name="Work"] [data-ext-remove]').click();
      await confirm(who.page);
      await who.page.locator('[data-ext-empty]').waitFor();
      await openCalendar(who);
      await who.page.waitForTimeout(500);
      assert.equal(await who.page.locator('[data-title^="Team lunch"]').count(), 0);
      assert.deepEqual(who.problems, []);
      await who.close();
    },
  );

  test(
    'import: preview a file with three events, leave one out, import; a second import reports what is already there; export reads back',
    T,
    async () => {
      const who = await account('Ian Import');
      const file = ics([
        allDay('imp-1@e2e', 'Kickoff', '20270309', ['DESCRIPTION:<b>Bring</b> notes']),
        [
          'BEGIN:VEVENT',
          'UID:imp-2@e2e',
          'DTSTART;TZID=Europe/Lisbon:20270310T100000',
          'DTEND;TZID=Europe/Lisbon:20270310T110000',
          'RRULE:FREQ=WEEKLY;COUNT=3',
          'SUMMARY:Weekly review',
          'END:VEVENT',
        ],
        allDay('imp-3@e2e', 'Offsite', '20270325'),
      ]);
      const upload = { name: 'plans.ics', mimeType: 'text/calendar', buffer: Buffer.from(file) };

      await openSync(who);
      await who.page.setInputFiles('[data-import-file]', upload);
      await who.page.waitForSelector('[data-import-preview]');
      assert.equal(await who.page.locator('[data-import-row]').count(), 3);
      assert.match(
        await who.page.locator('[data-import-row][data-import-title="Weekly review"]').innerText(),
        /Repeats/,
      );
      await who.page
        .locator('[data-import-row][data-import-title="Offsite"] [data-import-pick]')
        .uncheck();
      await who.page.click('[data-import-commit]');
      await who.page.waitForSelector('[data-import-result]');
      assert.match(
        await who.page.locator('[data-import-result]').innerText(),
        /2 added, 0 were already there/,
      );

      await openCalendar(who);
      await who.page.locator('[data-day="2027-03-09"] [data-title="Kickoff"]').waitFor();
      await who.page.locator('[data-day="2027-03-10"] [data-title="Weekly review"]').waitFor();
      await who.page.locator('[data-day="2027-03-17"] [data-title="Weekly review"]').waitFor();
      await who.page.locator('[data-day="2027-03-24"] [data-title="Weekly review"]').waitFor();
      assert.equal(await who.page.locator('[data-title="Offsite"]').count(), 0);
      assert.equal(
        (await sql('SELECT COUNT(*) AS n FROM `Event` WHERE ownerId = ?', [who.id]))[0].n,
        2n,
      );
      const [kick] = await sql("SELECT description FROM `Event` WHERE title = 'Kickoff'");
      assert.equal(kick.description, 'Bring notes'); // no markup comes in

      // the same file again: two are known, the third is new
      await openSync(who);
      await who.page.setInputFiles('[data-import-file]', upload);
      await who.page.waitForSelector('[data-import-preview]');
      assert.equal(await who.page.locator('[data-import-duplicate]').count(), 2);
      await who.page.click('[data-import-commit]');
      await who.page.waitForSelector('[data-import-result]');
      assert.match(
        await who.page.locator('[data-import-result]').innerText(),
        /1 added, 0 were already there/,
      );
      // and a third time: everything is there
      await who.page.setInputFiles('[data-import-file]', upload);
      await who.page.waitForSelector('[data-import-preview]');
      assert.equal(await who.page.locator('[data-import-duplicate]').count(), 3);
      assert.equal(await who.page.locator('[data-import-commit]').isDisabled(), true);
      assert.equal(
        (await sql('SELECT COUNT(*) AS n FROM `Event` WHERE ownerId = ?', [who.id]))[0].n,
        3n,
      );

      // a file that is not a calendar says so
      await who.page.setInputFiles('[data-import-file]', {
        name: 'x.ics',
        mimeType: 'text/calendar',
        buffer: Buffer.from('<html>no</html>'),
      });
      await who.page.waitForSelector('[data-import-error]');
      assert.match(
        await who.page.locator('[data-import-error]').innerText(),
        /not a calendar file/,
      );

      // export: a download that reads back as the same events
      await who.page.fill('[data-export-from]', '2027-03-01');
      await who.page.fill('[data-export-to]', '2027-03-31');
      const [download] = await Promise.all([
        who.page.waitForEvent('download'),
        who.page.click('[data-export-download]'),
      ]);
      assert.equal(download.suggestedFilename(), 'calendar.ics');
      const path = await download.path();
      const { readFileSync } = await import('node:fs');
      const exported = readFileSync(path, 'utf8');
      for (const title of ['Kickoff', 'Weekly review', 'Offsite'])
        assert.match(exported, new RegExp(`SUMMARY:${title}`));
      assert.deepEqual(who.problems, []);
      await who.close();
    },
  );
});
