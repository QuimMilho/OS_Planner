// End-to-end: offline merge and the Local history (phase 15). The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { positionBetween } from '@os-planner/shared';
import { launch, login, register, sql, startStack, verify, waitForOfflineReady } from './harness.mjs';

const T = { timeout: 300_000 };

let stack;
let browser;
let base;

before(async () => {
  stack = await startStack();
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await stack?.stop();
});

async function device() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on('console', (m) => /Content Security Policy|violates the following/i.test(m.text()) && problems.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  return { ctx, page, problems, close: async () => ctx.close() };
}

/** A person with a first device (registered, verified, in the app). */
async function account(name) {
  const d = await device();
  const { email } = await register(d.page, base, { name });
  await verify(d.page, email);
  await d.page.goto(`${base}/app`);
  await d.page.waitForSelector('app-rail');
  const [{ id, spaceId }] = await sql('SELECT u.id AS id, s.id AS spaceId FROM `User` u JOIN `Space` s ON s.userId = u.id WHERE u.email = ?', [email]);
  return { ...d, email, id, spaceId, name };
}

/** The same person on another device. */
async function secondDevice(who) {
  const d = await device();
  await login(d.page, base, who.email);
  return { ...d, email: who.email, id: who.id, spaceId: who.spaceId, name: who.name };
}

async function api(page, method, path, body) {
  return page.evaluate(
    async ([m, p, b]) => {
      const refresh = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'X-Requested-With': 'os_planner' } });
      const { accessToken } = await refresh.json();
      const res = await fetch(p, { method: m, headers: { Authorization: `Bearer ${accessToken}`, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, path, body ?? null],
  );
}

let lastPos = null;
const nextPos = () => (lastPos = positionBetween(lastPos, null));

async function apiBoard(page, spaceId, name = 'Sprint') {
  const id = randomUUID();
  const res = await api(page, 'POST', `/api/spaces/${spaceId}/boards`, { id, name, position: nextPos() });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const detail = (await api(page, 'GET', `/api/boards/${id}`)).body;
  return { id, columns: Object.fromEntries(detail.columns.map((c) => [c.name, c.id])) };
}

async function apiTask(page, boardId, columnId, title, extra = {}) {
  const res = await api(page, 'POST', `/api/boards/${boardId}/tasks`, { id: randomUUID(), columnId, position: nextPos(), title, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const taskRow = async (title) => (await sql('SELECT * FROM `Task` WHERE title = ? AND deletedAt IS NULL', [title]))[0];
const until = async (fn, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for the server');
    await new Promise((r) => setTimeout(r, 700));
  }
};

/** The board in its list view, with the rows loaded. */
async function openList(who, boardId, title) {
  await who.page.goto(`${base}/app/b/${boardId}`);
  await who.page.waitForSelector('[data-view=list]');
  await who.page.click('[data-view=list]');
  await who.page.locator(`tr[data-task="${title}"]`).waitFor();
}

const row = (page, title) => page.locator(`tr[data-task="${title}"]`);

async function goOnline(who) {
  await who.ctx.setOffline(false);
  await who.page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** The raw rows of the Local history on this device (the Yjs bytes left out). */
const historyRows = (page) =>
  page.evaluate(async () => {
    const info = (await indexedDB.databases()).find((d) => d.name?.startsWith('os_planner-'));
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(info.name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = await new Promise((res) => {
      const r = db.transaction('localHistory').objectStore('localHistory').getAll();
      r.onsuccess = () => res(r.result);
    });
    db.close();
    return all.map(({ state: _s, ...rest }) => rest);
  });

/** Writes rows into a store of this device's database (the app is not told: it picks them up on its next read). */
const putRows = (page, store, rows) =>
  page.evaluate(
    async ([name, items]) => {
      const info = (await indexedDB.databases()).find((d) => d.name?.startsWith('os_planner-'));
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(info.name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction(name, 'readwrite');
        const os = tx.objectStore(name);
        for (const item of items) os.put(item);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    [store, rows],
  );

const entry = (over = {}) => ({
  id: randomUUID(),
  at: Date.now(),
  createdAt: Date.now(),
  device: 'test',
  entity: 'task',
  entityId: randomUUID(),
  entityTitle: 'Synthetic',
  spaceId: randomUUID(),
  op: 'task.update',
  fieldsRejected: {},
  patch: {},
  snapshot: null,
  reason: 'conflict',
  resolved: 'none',
  expiresAt: Date.now() + 86_400_000,
  bytes: 200,
  ...over,
});

describe('two devices, one task', () => {
  test('fields merge, the loser keeps its title in the history, and Replace puts it back (reversibly)', T, async () => {
    const a = await account('Una Uno');
    const board = await apiBoard(a.page, a.spaceId, 'Merge board');
    await apiTask(a.page, board.id, board.columns['To do'], 'Merge me');
    const b = await secondDevice(a);
    await openList(a, board.id, 'Merge me');
    await openList(b, board.id, 'Merge me');
    await a.page.waitForTimeout(1500);
    await b.page.waitForTimeout(1500);

    await a.ctx.setOffline(true);
    await b.ctx.setOffline(true);
    // A: title and due date
    const ra = row(a.page, 'Merge me');
    await ra.locator('[data-cell=due]').fill('2027-05-01');
    const titleA = ra.locator('[data-cell=title]');
    await titleA.fill('A title');
    await titleA.press('Enter');
    await row(a.page, 'A title').waitFor();
    // B: title and priority
    const rb = row(b.page, 'Merge me');
    await rb.locator('[data-cell=priority]').selectOption('high');
    const titleB = rb.locator('[data-cell=title]');
    await titleB.fill('B title');
    await titleB.press('Enter');
    await row(b.page, 'B title').waitFor();
    assert.ok(await taskRow('Merge me'), 'nothing reached the server yet');

    // A is first back
    await goOnline(a);
    await until(() => taskRow('A title'));
    // B follows: its priority merges, its title is refused
    await goOnline(b);
    const merged = await until(async () => {
      const r = await taskRow('A title');
      return r?.priority === 'high' ? r : null;
    });
    assert.ok(merged.dueAt, 'A due date is there');
    assert.equal(await taskRow('B title'), undefined, 'the title of B did not overwrite the online one');

    // B shows the loser in its history
    await b.page.waitForSelector('[data-history-button]');
    await b.page.goto(`${base}/app/history`);
    const entryB = b.page.locator('[data-entry][data-entity=task]');
    await entryB.waitFor();
    assert.equal(await entryB.count(), 1);
    assert.equal(await entryB.getAttribute('data-reason'), 'conflict');
    assert.equal((await entryB.locator('[data-field=title] .mine').innerText()).trim(), 'B title');
    assert.equal((await entryB.locator('[data-field=title] .theirs').innerText()).trim(), 'A title');
    assert.equal(await entryB.locator('[data-field=priority]').count(), 0, 'the priority was not in conflict');

    // Replace: B's title is put back, the entry is settled, A sees it live
    await entryB.locator('[data-act=replace]').click();
    await until(() => taskRow('B title'));
    await b.page.locator('[data-entry]').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await a.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await row(a.page, 'B title').waitFor({ timeout: 45_000 });
    // what it overwrote is an entry of its own
    await b.page.waitForFunction(() => document.querySelectorAll('[data-entry][data-resolved=none]').length === 1);
    const again = b.page.locator('[data-entry][data-resolved=none]');
    assert.equal((await again.locator('[data-field=title] .mine').innerText()).trim(), 'A title');
    assert.equal((await again.locator('[data-field=title] .theirs').innerText()).trim(), 'B title');
    const rows = await historyRows(b.page);
    assert.equal(rows.filter((r) => r.resolved === 'replaced').length, 1);

    assert.deepEqual([...a.problems, ...b.problems], []);
    await a.close();
    await b.close();
  });
});

describe('a task that was deleted online', () => {
  test('Add as new brings the offline version back as a new task in the same column', T, async () => {
    const a = await account('Dora Deleted');
    const board = await apiBoard(a.page, a.spaceId, 'Gone board');
    const original = await apiTask(a.page, board.id, board.columns['Doing'], 'Gone soon');
    const b = await secondDevice(a);
    await openList(b, board.id, 'Gone soon');
    await b.page.waitForTimeout(1500);
    await b.ctx.setOffline(true);
    const title = row(b.page, 'Gone soon').locator('[data-cell=title]');
    await title.fill('Gone soon, edited');
    await title.press('Enter');
    await row(b.page, 'Gone soon, edited').waitFor();

    assert.equal((await api(a.page, 'DELETE', `/api/tasks/${original.id}`)).status, 204);
    await goOnline(b);
    await b.page.waitForSelector('[data-history-button]', { timeout: 45_000 });
    await b.page.goto(`${base}/app/history`);
    const e = b.page.locator('[data-entry][data-entity=task]');
    await e.waitFor();
    assert.equal(await e.getAttribute('data-reason'), 'target_deleted');
    assert.equal(await e.locator('[data-act=replace]').count(), 0, 'nothing left to replace');
    await e.locator('[data-act=add]').click();

    const made = await until(() => taskRow('Gone soon, edited (my version)'));
    assert.equal(made.columnId, board.columns['Doing'], 'in the same column');
    assert.notEqual(made.id, original.id);
    const [old] = await sql('SELECT deletedAt FROM `Task` WHERE id = ?', [original.id]);
    assert.ok(old.deletedAt, 'the original stays deleted');
    assert.equal(await b.page.locator('[data-entry][data-resolved=none]').count(), 0);
    assert.deepEqual([...a.problems, ...b.problems], []);
    await a.close();
    await b.close();
  });

  test('Add as new also makes an event again (same time, same space)', T, async () => {
    const a = await account('Eva Event');
    await a.page.goto(`${base}/app/history`);
    await a.page.waitForSelector('[data-history]');
    const eventId = randomUUID();
    const snapshot = {
      id: eventId,
      spaceId: a.spaceId,
      ownerId: a.id,
      ownerName: 'Eva Event',
      kind: 'meeting',
      title: 'Cancelled online',
      description: '',
      location: null,
      videoUrl: null,
      linkedChannelId: null,
      startAt: '2027-04-02T10:00:00.000Z',
      endAt: '2027-04-02T11:00:00.000Z',
      allDay: false,
      timezone: 'UTC',
      rrule: null,
      visibility: 'attendees',
      exceptions: [],
      attendeeCount: 1,
      counts: { invited: 0, accepted: 1, declined: 0, tentative: 0 },
      me: { status: 'accepted', addedBy: null, addedByName: null, via: 'owner', optional: false },
      seq: 3,
      createdAt: '2027-04-01T10:00:00.000Z',
      updatedAt: '2027-04-01T10:00:00.000Z',
      deletedAt: null,
    };
    await putRows(a.page, 'localHistory', [entry({ entity: 'event', entityId: eventId, entityTitle: 'Cancelled online', spaceId: a.spaceId, op: 'event.update', reason: 'target_deleted', snapshot, patch: { title: 'Cancelled online' } })]);
    await a.page.reload();
    const e = a.page.locator('[data-entry][data-entity=event]');
    await e.waitFor();
    await e.locator('[data-act=add]').click();
    const made = await until(async () => (await sql("SELECT *, DATE_FORMAT(startAt, '%Y-%m-%dT%H:%i:%s.000Z') AS startIso FROM `Event` WHERE title = ? AND deletedAt IS NULL", ['Cancelled online (my version)']))[0]);
    assert.equal(made.startIso, '2027-04-02T10:00:00.000Z');
    assert.equal(made.spaceId, a.spaceId);
    assert.deepEqual(a.problems, []);
    await a.close();
  });
});

describe('offline across boards, calendar and notebooks', () => {
  test('create and edit offline in all three; after reconnecting the server has one of each, and a repeat changes nothing', T, async () => {
    const me = await account('Omar Offline');
    const board = await apiBoard(me.page, me.spaceId, 'All three');
    await apiTask(me.page, board.id, board.columns['To do'], 'Edit me');
    await apiTask(me.page, board.id, board.columns['To do'], 'Delete me');
    // a notebook with a page, made online
    await me.page.goto(`${base}/app`);
    await me.page.click('text=Create your first notebook');
    await me.page.waitForSelector('app-inline-name input.edit');
    await me.page.keyboard.type('Cached notebook');
    await me.page.keyboard.press('Enter');
    await me.page.locator('app-tree-category .row', { hasText: 'General' }).first().waitFor();
    await openList(me, board.id, 'Edit me');
    await me.page.goto(`${base}/app/calendar?view=agenda&d=2027-03-15`);
    await me.page.waitForSelector('[data-calendar]');
    await me.page.waitForTimeout(2000);
    await waitForOfflineReady(me.page);
    await me.ctx.setOffline(true);
    await me.page.reload();
    await me.page.waitForSelector('[data-calendar]');

    // calendar: a new event
    await me.page.click('[data-action=new-event]');
    await me.page.waitForSelector('[data-event-dialog]');
    await me.page.fill('[data-field=title]', 'Offline meeting');
    await me.page.fill('[data-field=start-date]', '2027-03-18');
    await me.page.fill('[data-field=start-time]', '10:00');
    await me.page.fill('[data-field=end-time]', '10:30');
    await me.page.click('[data-action=save-event]');
    await me.page.waitForSelector('mat-dialog-container', { state: 'detached' });
    await me.page.locator('[data-agenda-day="2027-03-18"] [data-title="Offline meeting"]').waitFor();

    // boards: edit a task and make a new one
    await me.page.goto(`${base}/app/b/${board.id}`);
    await me.page.waitForSelector('[data-view=list]');
    await me.page.click('[data-view=list]');
    const title = row(me.page, 'Edit me').locator('[data-cell=title]');
    await title.fill('Edited offline');
    await title.press('Enter');
    await row(me.page, 'Edited offline').waitFor();
    // ... and delete one (through its panel)
    await row(me.page, 'Delete me').locator('.openbtn').click();
    await me.page.waitForSelector('[data-task-drawer]');
    await me.page.click('[data-task-menu]');
    await me.page.click('[data-action=delete-task]');
    await me.page.locator('mat-dialog-container button', { hasText: 'Delete' }).last().click();
    await me.page.waitForSelector('[data-task-drawer]', { state: 'detached' });
    await me.page.click('[data-view=board]');
    const quick = me.page.locator('[data-column="To do"] [data-quick-add]').first();
    await quick.fill('Made offline');
    await quick.press('Enter');
    await me.page.locator('article.card[data-task="Made offline"]').waitFor();

    // notebooks: a new page
    await me.page.goto(`${base}/app`);
    await me.page.waitForSelector('app-tree-category');
    const category = me.page.locator('app-tree-category .row', { hasText: 'General' }).first();
    await category.hover();
    await category.locator('button[aria-label="New page"]').click();
    await me.page.waitForSelector('.ProseMirror.doc');
    await me.page.fill('input.title', 'Offline page');
    await me.page.locator('input.title').press('Enter');

    assert.equal(await taskRow('Edited offline'), undefined, 'nothing reached the server yet');
    await goOnline(me);
    await until(() => taskRow('Edited offline'));
    await until(() => taskRow('Made offline'));
    await until(async () => (await sql("SELECT deletedAt FROM `Task` WHERE title = 'Delete me'"))[0]?.deletedAt);
    await until(async () => (await sql("SELECT id FROM `Event` WHERE title = 'Offline meeting' AND deletedAt IS NULL"))[0]);
    await until(async () => (await sql("SELECT id FROM `Page` WHERE title = 'Offline page' AND deletedAt IS NULL"))[0]);
    // once more: sending it all again makes no copies
    await goOnline(me);
    await me.page.waitForTimeout(3000);
    for (const [table, titleOf] of [['Task', 'Made offline'], ['Task', 'Edited offline'], ['Event', 'Offline meeting'], ['Page', 'Offline page']])
      assert.equal(Number((await sql(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE title = ? AND deletedAt IS NULL`, [titleOf]))[0].n), 1, `${titleOf} exists once`);
    assert.deepEqual((await historyRows(me.page)).filter((r) => r.reason !== 'pre_merge').map((r) => ({ op: r.op, title: r.entityTitle, reason: r.reason })), [], 'nothing was refused');
    assert.equal(await me.page.locator('[data-history-button]').count(), 0, 'and nothing waits for a decision');
    assert.deepEqual(me.problems, []);
    await me.close();
  });
});

describe('the Local history on a device', () => {
  test('entries of a space that is no longer accessible are purged and the person is told', T, async () => {
    const me = await account('Rita Revoked');
    const gone = randomUUID();
    await putRows(me.page, 'localHistory', [entry({ spaceId: gone, entityTitle: 'Lost team task' }), entry({ spaceId: me.spaceId, entityTitle: 'Still mine' })]);
    // the device holds a cursor for a space it can no longer see
    await putRows(me.page, 'meta', [{ key: 'cursors', value: { [me.spaceId]: 0, [gone]: 5 } }]);
    await me.page.reload();
    await me.page.waitForSelector('app-shell');
    await me.page.waitForSelector('text=You no longer have access to a team or project', { timeout: 45_000 });
    await until(async () => (await historyRows(me.page)).every((r) => r.spaceId !== gone));
    const left = await historyRows(me.page);
    assert.deepEqual(left.map((r) => r.entityTitle), ['Still mine']);
    assert.deepEqual(me.problems, []);
    await me.close();
  });

  test('retention and the cap purge the oldest first; Settings clears the history and sets the days', T, async () => {
    const me = await account('Hugo History');
    const DAY = 86_400_000;
    const now = Date.now();
    const old = entry({ entityTitle: 'Expired', at: now - 40 * DAY, createdAt: now - 40 * DAY, expiresAt: now - 10 * DAY });
    const fresh = entry({ entityTitle: 'Fresh', at: now - DAY, createdAt: now - DAY, expiresAt: now + 29 * DAY });
    await putRows(me.page, 'localHistory', [old, fresh]);
    await me.page.reload();
    await me.page.waitForSelector('app-shell');
    await until(async () => (await historyRows(me.page)).every((r) => r.entityTitle !== 'Expired'));
    assert.deepEqual((await historyRows(me.page)).map((r) => r.entityTitle), ['Fresh']);

    // more than the cap: the oldest go
    const many = Array.from({ length: 5003 }, (_, i) => entry({ entityTitle: `Bulk ${i}`, at: now - 3 * DAY + i, createdAt: now - 3 * DAY + i, bytes: 100 }));
    await putRows(me.page, 'localHistory', many);
    await me.page.reload();
    await me.page.waitForSelector('app-shell');
    await until(async () => (await historyRows(me.page)).length <= 5000);
    const rows = await historyRows(me.page);
    assert.equal(rows.length, 5000);
    assert.ok(!rows.some((r) => r.entityTitle === 'Bulk 0' || r.entityTitle === 'Bulk 1' || r.entityTitle === 'Bulk 2'), 'the oldest were dropped first');
    assert.ok(rows.some((r) => r.entityTitle === 'Fresh'), 'a newer one stays');

    // Settings -> Offline
    await me.page.goto(`${base}/app/settings`);
    await me.page.waitForSelector('[data-history-days]');
    await me.page.fill('[data-history-days]', '7');
    await me.page.locator('[data-history-days]').blur();
    await until(async () => (await historyRows(me.page)).every((r) => r.expiresAt <= Date.now() + 8 * DAY));
    await me.page.click('[data-history-clear]');
    await me.page.locator('mat-dialog-container button', { hasText: /Clear local history/ }).last().click();
    await until(async () => (await historyRows(me.page)).length === 0);
    assert.deepEqual(me.problems, []);
    await me.close();
  });
});
