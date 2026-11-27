// End-to-end: roles, overwrites, "view as" and the audit log. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { launch, register, sql, startStack, uniqueEmail, verify } from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('admin');
const ADMIN_EMAIL_2 = uniqueEmail('admin');
const EDIT_PAGES = 1n << 19n;

let stack;
let browser;
let base;

before(async () => {
  stack = await startStack({ env: { ADMIN_EMAILS: `${ADMIN_EMAIL},${ADMIN_EMAIL_2}` } });
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await stack?.stop();
});

async function device() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
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
  if (process.env.E2E_DEBUG)
    page.on(
      'response',
      (r) =>
        r.status() >= 400 &&
        /\/api\//.test(r.url()) &&
        console.log('  [api]', r.status(), r.request().method(), r.url().replace(base, '')),
    );
  return { ctx, page, problems, close: async () => ctx.close() };
}

/** A verified account on its own device. */
async function account(name, wanted) {
  const d = await device();
  const { email } = await register(d.page, base, { name, ...(wanted ? { email: wanted } : {}) });
  await verify(d.page, email);
  await d.page.goto(`${base}/app`);
  await d.page.waitForSelector('app-rail');
  const id = (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;
  return { ...d, email, id, name };
}

/** The instance admin creates a team for `owner` in the Administration page. Returns the team id. */
async function createTeam(admin, name, owner) {
  await admin.page.goto(`${base}/app/admin`);
  await admin.page.waitForSelector('[data-admin-teams]');
  await admin.page.fill('input[name=teamName]', name);
  await admin.page.fill('input[name=teamOwner]', owner.email);
  await admin.page.click('[data-create-team]');
  await admin.page.locator(`[data-team-row="${name}"]`).waitFor();
  return (await sql('SELECT id FROM `Team` WHERE name = ?', [name]))[0].id;
}

const joinTeam = (teamId, who) =>
  sql('INSERT INTO `TeamMember` (teamId, userId, joinedAt) VALUES (?, ?, NOW(3))', [
    teamId,
    who.id,
  ]);
const joinProject = (projectId, who) =>
  sql('INSERT INTO `ProjectMember` (projectId, userId, joinedAt) VALUES (?, ?, NOW(3))', [
    projectId,
    who.id,
  ]);

/** Calls the API as the signed-in person (from inside the page, so the refresh cookie applies). */
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

/** What the browser has stored about the person's permissions in a team (the PermissionStore's source). */
async function storedPermissions(page, who, teamId) {
  return page.evaluate(
    ([dbName, key]) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('meta').objectStore('meta').get(key);
          get.onsuccess = () => {
            db.close();
            resolve(get.result?.value ?? null);
          };
          get.onerror = () => reject(get.error);
        };
      }),
    [`os_planner-${who.id}`, `perm:${teamId}`],
  );
}

/** Retries until `check` returns something truthy; each round nudges the app to sync (as when the tab regains focus). */
async function eventually(page, check, what, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const result = await check();
    if (result) return result;
    if (Date.now() > end) assert.fail(`gave up waiting for: ${what}`);
    await page.waitForTimeout(500);
  }
}

async function answerPrompt(page, text) {
  const box = page.locator('mat-dialog-container input');
  await box.waitFor();
  await box.fill(text);
  await box.press('Enter');
  await page.waitForSelector('mat-dialog-container', { state: 'detached' });
}

/** The save button is enabled while there is something to save, and goes back to disabled once it is saved. */
const saved = (page, selector) =>
  page.waitForFunction(
    (s) => document.querySelector(s)?.getAttribute('data-dirty') === 'false',
    selector,
  );

async function newRole(page, name) {
  await page.click('[data-roles-editor] [data-action=new-role]');
  await answerPrompt(page, name);
  await page.locator(`[data-role-row="${name}"].on`).waitFor();
}

async function giveRole(page, who, roleName) {
  await page.click('[data-tab=members]');
  const row = page.locator(`[data-member-id="${who.id}"]`);
  await row.waitFor();
  await row.locator('[data-action=add-role]').click();
  await page.click(`[data-role-option="${roleName}"]`);
  await row.locator(`[data-chip="${roleName}"]`).waitFor();
}

describe('roles, overwrites and the audit log', () => {
  test(
    'a "Reviewer" role with only Edit pages: Bea edits pages but cannot create notebooks; revoking it updates her app and the API refuses',
    T,
    async () => {
      const admin = await account('The Admin', ADMIN_EMAIL);
      const owner = await account('Olga Owner');
      const bea = await account('Bea Reviewer');
      const teamId = await createTeam(admin, 'Reviewers Inc', owner);
      await joinTeam(teamId, bea);
      const spaceId = (await sql('SELECT spaceId FROM `Team` WHERE id = ?', [teamId]))[0].spaceId;

      // the owner puts a notebook with a page into the team's space (the team notebooks UI comes with a later phase)
      const nb = randomUUID();
      const cat = randomUUID();
      const pageId = randomUUID();
      assert.equal(
        (
          await api(owner.page, 'POST', '/api/notebooks', {
            id: nb,
            spaceId,
            name: 'Specs',
            position: 'a0',
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await api(owner.page, 'POST', '/api/categories', {
            id: cat,
            notebookId: nb,
            name: 'Docs',
            position: 'a0',
          })
        ).status,
        201,
      );
      const created = await api(owner.page, 'POST', '/api/pages', {
        id: pageId,
        categoryId: cat,
        title: 'Plan',
        position: 'a0',
      });
      assert.equal(created.status, 201);
      const write = (who, text, version) =>
        api(who.page, 'POST', `/api/pages/${pageId}/snapshots/replace`, {
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
          },
          baseVersion: version,
        });

      // before the role: Bea can read the notebook but not write in it
      assert.equal((await write(bea, 'too early', created.body.version)).status, 403);

      // --- the owner creates "Reviewer": colour, mentionable, Edit pages only
      await owner.page.goto(`${base}/app/t/${teamId}/settings`);
      await owner.page.waitForSelector('[data-team-settings]');
      await owner.page.click('[data-tab=roles]');
      await newRole(owner.page, 'Reviewer');
      await owner.page.fill('input[name=role-color]', '#3366cc');
      await owner.page.check('input[name=role-mentionable]');
      await owner.page
        .locator('[data-roles-editor] [data-permission-grid] [data-perm=EDIT_PAGES] input.check')
        .check();
      await owner.page.click('[data-action=save-role]');
      await saved(owner.page, '[data-action=save-role]');

      const [role] = await sql(
        'SELECT id, name, color, mentionable, permissions FROM `Role` WHERE name = ?',
        ['Reviewer'],
      );
      assert.equal(role.color, '#3366cc');
      assert.equal(Number(role.mentionable), 1);
      assert.equal(BigInt(role.permissions), EDIT_PAGES, 'only Edit pages');

      // --- assigned to Bea through the members tab
      await giveRole(owner.page, bea, 'Reviewer');
      assert.equal(
        (
          await sql('SELECT COUNT(*) AS n FROM `MemberRole` WHERE userId = ? AND roleId = ?', [
            bea.id,
            role.id,
          ])
        )[0].n,
        1n,
      );

      // --- Bea's app picks it up when it syncs (the same refresh as when the tab regains focus)
      await eventually(
        bea.page,
        async () => {
          const stored = await storedPermissions(bea.page, bea, teamId);
          return stored && (BigInt(stored.permissions) & EDIT_PAGES) !== 0n;
        },
        'Bea’s stored permissions include Edit pages',
      );
      const first = await write(bea, 'Reviewed by Bea', created.body.version);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(
        (
          await api(bea.page, 'POST', '/api/notebooks', {
            id: randomUUID(),
            spaceId,
            name: 'Not allowed',
            position: 'a1',
          })
        ).status,
        403,
        'Edit pages does not include creating notebooks',
      );

      // --- the owner takes the role away; Bea's app follows and the API refuses
      await owner.page.click('[data-tab=members]');
      const chip = owner.page.locator(`[data-member-id="${bea.id}"] [data-chip="Reviewer"]`);
      await chip.locator('[data-action=remove-role]').click();
      await chip.waitFor({ state: 'detached' });
      await eventually(
        bea.page,
        async () => {
          const stored = await storedPermissions(bea.page, bea, teamId);
          return stored && (BigInt(stored.permissions) & EDIT_PAGES) === 0n;
        },
        'Bea’s stored permissions no longer include Edit pages',
      );
      assert.equal((await write(bea, 'after revoking', first.body.version)).status, 403);

      assert.deepEqual(
        [admin, owner, bea].flatMap((d) => d.problems),
        [],
        'no CSP violations or page errors',
      );
      for (const d of [admin, owner, bea]) await d.close();
    },
  );

  test(
    'tri-state overwrites: deny on a project for @everyone and allow for "Dev"; Dana sees it, Pat gets a 404; "view as" and the audit log explain it',
    T,
    async () => {
      const admin = await account('The Admin', ADMIN_EMAIL_2);
      const owner = await account('Olga Owner');
      const dana = await account('Dana Dev');
      const pat = await account('Pat Plain');
      const teamId = await createTeam(admin, 'Gamma', owner);
      await joinTeam(teamId, dana);
      await joinTeam(teamId, pat);

      // --- the owner creates the project "Secret" and puts both members in it
      await owner.page.goto(`${base}/app/t/${teamId}`);
      await owner.page.waitForSelector('[data-team-page]');
      await owner.page.click('app-team-page [data-action=new-project]');
      await answerPrompt(owner.page, 'Secret');
      await owner.page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
      const projectId = (await sql('SELECT id FROM `Project` WHERE name = ?', ['Secret']))[0].id;
      await joinProject(projectId, dana);
      await joinProject(projectId, pat);

      // --- the role "Dev", given to Dana
      await owner.page.goto(`${base}/app/t/${teamId}/settings?tab=roles`);
      await owner.page.waitForSelector('[data-roles-editor]');
      await newRole(owner.page, 'Dev');
      await giveRole(owner.page, dana, 'Dev');

      // --- a plain member has no Roles or Audit tab, can read the chips and cannot change them
      await pat.page.goto(`${base}/app/t/${teamId}/settings`);
      await pat.page.waitForSelector('[data-team-settings]');
      assert.equal(
        await pat.page.locator('[data-tab=roles]').count(),
        0,
        'no Roles tab without Manage roles',
      );
      assert.equal(
        await pat.page.locator('[data-tab=audit]').count(),
        0,
        'no Audit tab without View audit log',
      );
      await pat.page.locator(`[data-member-id="${dana.id}"] [data-chip="Dev"]`).waitFor();
      assert.equal(
        await pat.page.locator('[data-action=add-role]').count(),
        0,
        'and the roles cannot be changed',
      );

      // --- tri-state: deny every "view" permission for @everyone ...
      await owner.page.goto(`${base}/app/t/${teamId}/p/${projectId}/settings`);
      await owner.page.waitForSelector('[data-overwrite-editor]');
      const grid = owner.page.locator('[data-overwrite-editor] [data-permission-grid]');
      const VIEWS = ['VIEW_CHANNEL', 'VIEW_NOTEBOOKS', 'VIEW_BOARDS', 'VIEW_CALENDAR'];
      await owner.page.locator('[data-overwrite-editor] [data-subject="@everyone"].on').waitFor();
      assert.equal(
        await owner.page.locator('[data-overwrite-state]').getAttribute('data-synced'),
        'true',
        'nothing set yet: synced with the parent',
      );
      for (const v of VIEWS) await grid.locator(`[data-perm=${v}] [data-set=deny]`).click();
      assert.equal(
        await grid
          .locator('[data-perm=VIEW_NOTEBOOKS] [data-set=deny]')
          .getAttribute('aria-checked'),
        'true',
      );
      await owner.page.click('[data-action=save-overwrite]');
      await saved(owner.page, '[data-action=save-overwrite]');
      assert.equal(
        await owner.page.locator('[data-overwrite-state]').getAttribute('data-synced'),
        'false',
        'now set at this level',
      );

      // ... and allow them for "Dev"
      await owner.page.click('[data-overwrite-editor] [data-subject="Dev"]');
      await owner.page.locator('[data-overwrite-editor] [data-subject="Dev"].on').waitFor();
      assert.equal(
        await owner.page.locator('[data-overwrite-state]').getAttribute('data-synced'),
        'true',
      );
      for (const v of VIEWS) await grid.locator(`[data-perm=${v}] [data-set=allow]`).click();
      await owner.page.click('[data-action=save-overwrite]');
      await saved(owner.page, '[data-action=save-overwrite]');
      assert.equal(
        (await sql('SELECT COUNT(*) AS n FROM `Overwrite` WHERE targetId = ?', [projectId]))[0].n,
        2n,
      );

      // --- Dana (Dev) sees the project and can open it
      await dana.page.goto(`${base}/app/t/${teamId}`);
      await dana.page.waitForSelector('[data-project-tree] [data-project="Secret"]');
      await dana.page.goto(`${base}/app/t/${teamId}/p/${projectId}`);
      await dana.page.waitForSelector('[data-team-page]');
      assert.equal(await dana.page.locator('[data-title]').innerText(), 'Secret');

      // --- Pat (in the project, but only @everyone) does not: not in the tree, and the address is a 404
      await pat.page.goto(`${base}/app/t/${teamId}`);
      await pat.page.waitForSelector('[data-team-sidebar]');
      await pat.page.waitForFunction(
        () => !document.querySelector('[data-project-tree] [data-project="Secret"]'),
      );
      await pat.page.goto(`${base}/app/t/${teamId}/p/${projectId}`);
      await pat.page.waitForSelector('app-not-found');
      assert.equal((await api(pat.page, 'GET', `/api/projects/${projectId}`)).status, 404);
      assert.equal((await api(dana.page, 'GET', `/api/projects/${projectId}`)).status, 200);

      // --- "view as": why can Pat not see notebooks here? The page names the deciding rule.
      await owner.page.goto(`${base}/app/t/${teamId}/p/${projectId}/settings`);
      await owner.page.waitForSelector('[data-view-as]');
      await owner.page.selectOption('select[name=view-as-subject]', `member:${pat.id}`);
      const patNotebooks = owner.page.locator('[data-view-as-perm=VIEW_NOTEBOOKS]');
      await patNotebooks.waitFor();
      assert.equal(await patNotebooks.getAttribute('data-granted'), 'false');
      const patReason = await patNotebooks.locator('[data-reason]').innerText();
      assert.match(patReason, /Denied/);
      assert.match(patReason, /@everyone/);
      assert.match(patReason, /Secret/, 'it names the project where the overwrite sits');
      await owner.page.selectOption('select[name=view-as-subject]', `member:${dana.id}`);
      await owner.page.locator('[data-view-as-perm=VIEW_NOTEBOOKS][data-granted=true]').waitFor();
      assert.match(
        await owner.page.locator('[data-view-as-perm=VIEW_NOTEBOOKS] [data-reason]').innerText(),
        /Dev/,
      );

      // --- the audit log lists what was done, with the right people
      await owner.page.goto(`${base}/app/t/${teamId}/settings?tab=audit`);
      await owner.page.waitForSelector('[data-audit-list] [data-audit]');
      const entry = (action) => owner.page.locator(`[data-audit="${action}"]`);
      assert.equal(
        await entry('team.create').locator('[data-audit-actor]').innerText(),
        'The Admin',
      );
      for (const action of ['project.create', 'role.create', 'role.assign', 'overwrite.set'])
        assert.equal(
          await entry(action).first().locator('[data-audit-actor]').innerText(),
          'Olga Owner',
          action,
        );
      assert.equal(await entry('overwrite.set').count(), 2);
      assert.equal(await entry('role.create').count(), 1);
      await entry('overwrite.set').first().locator('button.summary').click();
      const diff = await owner.page.locator('[data-audit-diff]').first().innerText();
      assert.match(diff, /Dev|@everyone/);
      assert.match(diff, /allow|deny/);

      // the filter narrows the list to one kind of action
      await owner.page.selectOption('select[name=audit-action]', 'overwrite.set');
      await owner.page.click('[data-action=audit-apply]');
      await owner.page.waitForFunction(
        () => document.querySelectorAll('[data-audit]').length === 2,
      );

      // and the API keeps the log from somebody without View audit log
      assert.equal((await api(pat.page, 'GET', `/api/teams/${teamId}/audit`)).status, 403);

      assert.deepEqual(
        [admin, owner, dana, pat].flatMap((d) => d.problems),
        [],
        'no CSP violations or page errors',
      );
      for (const d of [admin, owner, dana, pat]) await d.close();
    },
  );
});
