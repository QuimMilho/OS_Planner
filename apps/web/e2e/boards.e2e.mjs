// End-to-end: boards and tasks. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { positionBetween } from '@os-planner/shared';
import { launch, register, sql, startStack, uniqueEmail, verify } from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('boardsadmin');

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

async function device() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on('console', (m) => /Content Security Policy|violates the following/i.test(m.text()) && problems.push(m.text().slice(0, 200)));
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
  const [row] = await sql('SELECT t.id, s.id AS spaceId FROM `Team` t JOIN `Space` s ON s.teamId = t.id WHERE t.name = ?', [name]);
  return { id: row.id, spaceId: row.spaceId };
}

const joinTeam = (team, who) => sql('INSERT INTO `TeamMember` (teamId, userId, joinedAt) VALUES (?, ?, NOW(3))', [team.id, who.id]);

/** Calls the API as the signed-in person of that page. */
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

async function answerPrompt(page, text) {
  const box = page.locator('mat-dialog-container input').first();
  await box.waitFor();
  await box.fill(text);
  await box.press('Enter');
  await page.waitForSelector('mat-dialog-container', { state: 'detached' });
}

let lastPos = null;
const nextPos = () => (lastPos = positionBetween(lastPos, null)); // a0, a1, ... a9, aA, ...

/** A board through the API (with To do, Doing and Done); returns its id and columns by name. */
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

const card = (page, title) => page.locator(`article.card[data-task="${title}"]`);
const cardIn = (page, column, title) => page.locator(`[data-column="${column}"] article.card[data-task="${title}"]`);

/** Lifts a card with the mouse and drops it in the middle of another column's list of cards. */
async function drag(page, from, column) {
  const target = page.locator(`[data-cards="${column}"]`);
  const a = await from.boundingBox();
  const b = await target.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 30), { steps: 20 });
  await page.mouse.up();
}

const taskRow = async (title) => (await sql('SELECT * FROM `Task` WHERE title = ? AND deletedAt IS NULL', [title]))[0];

describe('boards and tasks', () => {
  test('a board with three columns and tasks: drag between columns, the second person sees it live, a full column refuses a drop', T, async () => {
    const owner = await account('Olivia Owner');
    const member = await account('Mia Member');
    const team = await createTeam('Boardwalk', owner);
    await joinTeam(team, member);

    // the owner makes a board from the sidebar
    await owner.page.goto(`${base}/app/t/${team.id}`);
    await owner.page.waitForSelector('[data-action=new-board]');
    await owner.page.click('[data-action=new-board]');
    await answerPrompt(owner.page, 'Launch');
    await owner.page.waitForURL(/\/app\/b\/[0-9a-f-]{36}$/);
    await owner.page.waitForSelector('[data-board-page][data-board-id]');
    const boardId = owner.page.url().split('/').pop();
    for (const name of ['To do', 'Doing', 'Done']) await owner.page.waitForSelector(`[data-column="${name}"]`);

    for (const title of ['Task A', 'Task B', 'Task C']) {
      const box = owner.page.locator('[data-column="To do"] [data-quick-add]');
      await box.fill(title);
      await box.press('Enter');
      await cardIn(owner.page, 'To do', title).waitFor();
    }
    assert.equal(await owner.page.locator('[data-column="To do"] article.card').count(), 3);

    // the second person opens it and sees the same
    await member.page.goto(`${base}/app/b/${boardId}`);
    await member.page.waitForSelector('[data-board-page]');
    for (const title of ['Task A', 'Task B', 'Task C']) await cardIn(member.page, 'To do', title).waitFor();
    // ... and has no way to add or drag (view only)
    assert.equal(await member.page.locator('[data-quick-add]').count(), 0);

    // drag A to Doing: the owner sees it move, the member sees it live without doing anything
    await drag(owner.page, card(owner.page, 'Task A'), 'Doing');
    await cardIn(owner.page, 'Doing', 'Task A').waitFor();
    await cardIn(member.page, 'Doing', 'Task A').waitFor({ timeout: 30_000 });
    assert.equal((await taskRow('Task A')).columnId, (await sql('SELECT id FROM `BoardColumn` WHERE boardId = ? AND name = ?', [boardId, 'Doing']))[0].id);

    // a limit of one in Doing: a second card is refused with a message and stays where it was
    await owner.page.click('[data-board-menu]');
    await owner.page.click('[data-action=board-settings]');
    const wip = owner.page.locator('[data-column-setting="Doing"] [data-column-wip]');
    await wip.fill('1');
    await wip.press('Tab');
    await owner.page.waitForFunction(async () => (await fetch('/api/health')).ok); // let the change go out
    await owner.page.keyboard.press('Escape');
    await owner.page.waitForSelector('mat-dialog-container', { state: 'detached' });
    await owner.page.waitForSelector('[data-column="Doing"] [data-wip][data-count="1"]');
    await owner.page.waitForFunction(() => /1\/1/.test(document.querySelector('[data-column="Doing"] [data-wip]')?.textContent ?? ''));

    await drag(owner.page, card(owner.page, 'Task B'), 'Doing');
    await owner.page.waitForSelector('.mat-mdc-snack-bar-container');
    assert.match(await owner.page.locator('.mat-mdc-snack-bar-container').innerText(), /full/i);
    await cardIn(owner.page, 'To do', 'Task B').waitFor();
    assert.equal((await taskRow('Task B')).columnId, (await sql('SELECT id FROM `BoardColumn` WHERE boardId = ? AND name = ?', [boardId, 'To do']))[0].id);

    // the keyboard: Alt+Arrow moves a card between columns, and a full column refuses that too
    await card(owner.page, 'Task C').focus();
    await owner.page.keyboard.press('Alt+ArrowRight');
    await owner.page.waitForSelector('.mat-mdc-snack-bar-container');
    await cardIn(owner.page, 'To do', 'Task C').waitFor();

    assert.deepEqual(owner.problems, []);
    assert.deepEqual(member.problems, []);
    await owner.close();
    await member.close();
  });

  test('the task panel: assign, label, dates, checklist, subtask and a comment that mentions somebody; the history shows each step', T, async () => {
    const owner = await account('Olga Owner');
    const mia = await account('Mia Mention');
    const team = await createTeam('Panelists', owner);
    await joinTeam(team, mia);
    const board = await apiBoard(owner.page, team.spaceId, 'Panel');
    await api(owner.page, 'POST', `/api/spaces/${team.spaceId}/labels`, { id: randomUUID(), name: 'bug', color: '#d92d20' });
    await apiTask(owner.page, board.id, board.columns['To do'], 'Fix the login');

    await owner.page.goto(`${base}/app/b/${board.id}`);
    await card(owner.page, 'Fix the login').click();
    await owner.page.waitForSelector('[data-task-drawer]');
    assert.match(owner.page.url(), /task=/);

    await owner.page.click('[data-action=assign-me]');
    await owner.page.locator('[data-assignee="Olga Owner"]').waitFor();

    await owner.page.click('[data-action=label-menu]');
    await owner.page.click('[data-label-option="bug"]');
    await owner.page.locator('.lab[data-label="bug"]').waitFor();
    await owner.page.keyboard.press('Escape');

    await owner.page.fill('[data-field=due]', '2026-12-24T10:00');
    await owner.page.locator('[data-field=due]').press('Tab');

    const item = owner.page.locator('[data-checklist-add]');
    await item.fill('Reproduce it');
    await item.press('Enter');
    await owner.page.locator('[data-checklist-item="Reproduce it"]').waitFor();
    // the first change goes to the server before the second, so the history has a line for each
    await owner.page.waitForSelector('[data-activity-kind="checklist_added"]', { timeout: 30_000 });
    await owner.page.locator('[data-checklist-item="Reproduce it"] input[type=checkbox]').check();
    await owner.page.waitForFunction(() => /1\/1/.test(document.querySelector('[data-checklist-progress]')?.textContent ?? ''));

    const sub = owner.page.locator('[data-subtask-add]');
    await sub.fill('Write a test');
    await sub.press('Enter');
    await owner.page.locator('[data-subtask="Write a test"]').waitFor();

    // a comment that mentions Mia: type "@Mi" and pick her
    const box = owner.page.locator('[data-comment-input]');
    await box.click();
    await box.pressSequentially('Please check @Mi');
    await owner.page.click('[data-mention-option="Mia Mention"]');
    await box.pressSequentially('thanks');
    await owner.page.click('[data-action=send-comment]');
    await owner.page.locator('[data-comment]').waitFor();
    assert.equal(await owner.page.locator('[data-comment] [data-mention]').innerText(), '@Mia Mention');

    // the server has all of it, and the history shows each step
    for (const kind of ['created', 'assigned', 'labeled', 'dates', 'checklist_added', 'checklist_done', 'subtask_added', 'comment'])
      await owner.page.waitForSelector(`[data-activity-kind="${kind}"]`, { timeout: 30_000 });
    const row = await taskRow('Fix the login');
    assert.ok(row.dueAt);
    assert.equal((await sql('SELECT COUNT(*) AS n FROM `TaskAssignee` WHERE taskId = ?', [row.id]))[0].n, 1n);
    assert.equal((await sql('SELECT COUNT(*) AS n FROM `TaskLabel` WHERE taskId = ?', [row.id]))[0].n, 1n);

    // Mia is told, and her inbox opens the task
    const [note] = await sql("SELECT kind, targetKind, targetId FROM `Notification` WHERE userId = ? AND kind = 'mention_user'", [mia.id]);
    assert.deepEqual({ kind: note.kind, targetKind: note.targetKind, targetId: note.targetId }, { kind: 'mention_user', targetKind: 'task', targetId: row.id });
    await mia.page.goto(`${base}/app`);
    await mia.page.waitForSelector('app-bell');
    await mia.page.click('app-bell button.bell');
    await mia.page.locator('text=Please check').first().click();
    await mia.page.waitForURL(new RegExp(`/app/b/${board.id}\\?task=${row.id}`));
    await mia.page.waitForSelector('[data-task-drawer]');
    // Mia may see everything but change nothing (only look): the fields are locked
    assert.equal(await mia.page.locator('[data-task-title]').isDisabled(), true);
    assert.equal(await mia.page.locator('[data-field=priority]').isDisabled(), true);

    assert.deepEqual(owner.problems, []);
    await owner.close();
    await mia.close();
  });

  test('"My tasks" lists tasks of two teams and a personal board and groups them as overdue, today and upcoming (at a fixed time)', T, async () => {
    const me = await account('Tina Tasks');
    const alpha = await createTeam('Alpha team', me);
    const beta = await createTeam('Beta team', me);
    const personalSpace = (await sql('SELECT id FROM `Space` WHERE userId = ?', [me.id]))[0].id;
    const a = await apiBoard(me.page, alpha.spaceId, 'Alpha board');
    const b = await apiBoard(me.page, beta.spaceId, 'Beta board');
    const p = await apiBoard(me.page, personalSpace, 'Private board');
    const day = (d) => `2026-03-${String(d).padStart(2, '0')}T00:00:00.000Z`;
    await apiTask(me.page, a.id, a.columns['To do'], 'Alpha late', { assigneeIds: [me.id], dueAt: day(9), allDay: true });
    await apiTask(me.page, a.id, a.columns['To do'], 'Alpha today', { assigneeIds: [me.id], dueAt: day(11), allDay: true });
    await apiTask(me.page, b.id, b.columns['To do'], 'Beta soon', { assigneeIds: [me.id], dueAt: day(14), allDay: true });
    await apiTask(me.page, b.id, b.columns['To do'], 'Beta later', { assigneeIds: [me.id], dueAt: day(20), allDay: true });
    await apiTask(me.page, b.id, b.columns['To do'], 'Not mine', { dueAt: day(9), allDay: true });
    await apiTask(me.page, p.id, p.columns['To do'], 'Private late', { assigneeIds: [me.id], dueAt: day(1), allDay: true });
    await apiTask(me.page, p.id, p.columns['To do'], 'Private undated', { assigneeIds: [me.id] });

    // the clock says 11 March 2026, midday
    await me.ctx.clock.setFixedTime(new Date('2026-03-11T12:00:00.000Z'));
    await me.page.goto(`${base}/app/tasks`);
    await me.page.waitForSelector('[data-my-tasks]');
    await me.page.waitForSelector('[data-group="overdue"]', { timeout: 30_000 });
    const titles = async (state) => (await me.page.locator(`[data-group="${state}"] a.task .ttl`).allInnerTexts()).map((t) => t.trim());
    await me.page.waitForFunction(() => document.querySelectorAll('a.task').length === 6, null, { timeout: 30_000 });
    assert.deepEqual(await titles('overdue'), ['Private late', 'Alpha late']);
    assert.deepEqual(await titles('today'), ['Alpha today']);
    assert.deepEqual(await titles('upcoming'), ['Beta soon', 'Beta later']);
    assert.deepEqual(await titles('none'), ['Private undated']);
    // the order of the groups on the page
    assert.deepEqual(await me.page.locator('[data-my-tasks] section').evaluateAll((s) => s.map((x) => x.dataset.group)), ['overdue', 'today', 'upcoming', 'none']);
    // a task opens its board with the panel
    await me.page.locator('a.task', { hasText: 'Beta soon' }).click();
    await me.page.waitForURL(/\/app\/b\/[0-9a-f-]{36}\?task=/);
    await me.page.waitForSelector('[data-task-drawer]');
    assert.deepEqual(me.problems, []);
    await me.close();
  });

  test('offline: rename a task and move it; after reconnecting the server has both changes', T, async () => {
    const owner = await account('Otto Offline');
    const team = await createTeam('Offliners', owner);
    const board = await apiBoard(owner.page, team.spaceId, 'Offline board');
    await apiTask(owner.page, board.id, board.columns['To do'], 'Write report');
    await apiTask(owner.page, board.id, board.columns['To do'], 'Keep still');

    await owner.page.goto(`${base}/app/b/${board.id}`);
    await card(owner.page, 'Write report').waitFor();
    await owner.page.waitForFunction(async () => (await navigator.serviceWorker?.getRegistration()) !== undefined || true);

    await owner.ctx.setOffline(true);
    // rename in the list view
    await owner.page.click('[data-view=list]');
    const title = owner.page.locator('tr[data-task="Write report"] [data-cell=title]');
    await title.fill('Write the report');
    await title.press('Enter');
    await owner.page.locator('tr[data-task="Write the report"]').waitFor();
    // move with the keyboard on the board
    await owner.page.click('[data-view=board]');
    await card(owner.page, 'Write the report').focus();
    await owner.page.keyboard.press('Alt+ArrowRight');
    await cardIn(owner.page, 'Doing', 'Write the report').waitFor();
    // nothing has reached the server yet
    assert.ok(await taskRow('Write report'));
    assert.equal(await taskRow('Write the report'), undefined);

    await owner.ctx.setOffline(false);
    await owner.page.evaluate(() => dispatchEvent(new Event('online')));
    const doingId = (await sql('SELECT id FROM `BoardColumn` WHERE boardId = ? AND name = ?', [board.id, 'Doing']))[0].id;
    let row;
    for (let i = 0; i < 60 && !(row = await taskRow('Write the report')); i++) await new Promise((r) => setTimeout(r, 1000));
    assert.ok(row, 'the rename reached the server');
    for (let i = 0; i < 30 && row.columnId !== doingId; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      row = await taskRow('Write the report');
    }
    assert.equal(row.columnId, doingId, 'the move reached the server');
    assert.equal((await taskRow('Keep still')).columnId, board.columns['To do']);
    assert.deepEqual(owner.problems, []);
    await owner.close();
  });

  test('a person who may only look sees the board but cannot add, drag or edit', T, async () => {
    const owner = await account('Oscar Owner');
    const viewer = await account('Vera Viewer');
    const team = await createTeam('Lookers', owner);
    await joinTeam(team, viewer);
    const board = await apiBoard(owner.page, team.spaceId, 'Read only');
    await apiTask(owner.page, board.id, board.columns['To do'], 'Look but do not touch');

    await viewer.page.goto(`${base}/app/b/${board.id}`);
    await card(viewer.page, 'Look but do not touch').waitFor();
    await viewer.page.waitForTimeout(1500); // let the permissions arrive
    assert.equal(await viewer.page.locator('[data-quick-add]').count(), 0);
    assert.equal(await viewer.page.locator('[data-action=new-task]').count(), 0);
    assert.equal(await viewer.page.locator('[data-action=new-board]').count(), 0);
    // dragging does nothing
    await drag(viewer.page, card(viewer.page, 'Look but do not touch'), 'Doing');
    await viewer.page.waitForTimeout(500);
    await cardIn(viewer.page, 'To do', 'Look but do not touch').waitFor();
    // the keyboard does nothing either
    await card(viewer.page, 'Look but do not touch').focus();
    await viewer.page.keyboard.press('Alt+ArrowRight');
    await viewer.page.waitForTimeout(500);
    await cardIn(viewer.page, 'To do', 'Look but do not touch').waitFor();
    // the panel opens, locked
    await card(viewer.page, 'Look but do not touch').click();
    await viewer.page.waitForSelector('[data-task-drawer]');
    assert.equal(await viewer.page.locator('[data-task-title]').isDisabled(), true);
    assert.equal(await viewer.page.locator('[data-field=status]').isDisabled(), true);
    assert.equal(await viewer.page.locator('[data-action=assign-me]').count(), 0);
    assert.equal(await viewer.page.locator('[data-comment-input]').count(), 0);
    // the server agrees
    const res = await api(viewer.page, 'POST', `/api/boards/${board.id}/tasks`, { id: randomUUID(), columnId: board.columns['To do'], position: 'a9', title: 'sneaky' });
    assert.equal(res.status, 403);
    assert.equal(await taskRow('sneaky'), undefined);
    assert.deepEqual(viewer.problems, []);
    await owner.close();
    await viewer.close();
  });
});
