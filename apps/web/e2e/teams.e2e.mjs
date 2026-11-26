// End-to-end: teams, projects and the hierarchy. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
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

const T = { timeout: 240_000 };
const ADMIN_EMAIL = uniqueEmail('admin');
const ADMIN_EMAIL_2 = uniqueEmail('admin');

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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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

/** A verified account on its own device. */
async function account(name, wanted) {
  const d = await device();
  const { email } = await register(d.page, base, { name, ...(wanted ? { email: wanted } : {}) });
  await verify(d.page, email);
  await d.page.goto(`${base}/app`);
  await d.page.waitForSelector('app-rail');
  return { ...d, email };
}

const userId = async (email) => (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;
const projectId = async (name) =>
  (await sql('SELECT id FROM `Project` WHERE name = ?', [name]))[0].id;
const crumbs = (page) => page.locator('[data-breadcrumb] a').allInnerTexts();

/** Types into the name dialog and confirms it. */
async function answerPrompt(page, text) {
  const box = page.locator('mat-dialog-container input');
  await box.waitFor();
  await box.fill(text);
  await box.press('Enter');
  await page.waitForSelector('mat-dialog-container', { state: 'detached' });
}

describe('teams and projects', () => {
  test(
    'an admin creates a team; its owner builds and reorganises the project tree; others see it, strangers do not',
    T,
    async () => {
      const admin = await account('The Admin', ADMIN_EMAIL);
      const owner = await account('Olga Owner');
      const member = await account('Max Member');
      const stranger = await account('Sam Stranger');

      // --- admin → Teams: create a team naming Olga as its owner
      await admin.page.goto(`${base}/app/admin`);
      await admin.page.waitForSelector('[data-admin-teams]');
      await admin.page.fill('input[name=teamName]', 'Acme');
      await admin.page.fill('input[name=teamOwner]', owner.email);
      await admin.page.click('[data-create-team]');
      const row = admin.page.locator('[data-team-row="Acme"]');
      await row.waitFor();
      assert.equal(
        await row.locator('[data-pending]').count(),
        0,
        'the owner has a verified account, so nothing is pending',
      );
      assert.match(await row.innerText(), /Olga Owner/);

      // --- the owner finds it in the rail and opens it
      await owner.page.reload();
      const railItem = owner.page.locator('app-rail [data-team="Acme"]');
      await railItem.waitFor();
      const teamPath = new URL(await railItem.getAttribute('href'), base).pathname;
      await railItem.click();
      await owner.page.waitForSelector('[data-team-page]');
      assert.equal(await owner.page.locator('[data-title]').innerText(), 'Acme');
      assert.deepEqual(await crumbs(owner.page), ['Acme']);
      await owner.page.waitForSelector('[data-team-sidebar]');

      // --- a stranger gets the same page as for an address that does not exist
      await stranger.page.goto(`${base}${teamPath}`);
      await stranger.page.waitForSelector('app-not-found');
      assert.equal(await stranger.page.locator('[data-team-page]').count(), 0);
      assert.equal(await stranger.page.locator('app-rail [data-team]').count(), 0);

      // --- a project and a sub-project
      await owner.page.click('app-team-page [data-action=new-project]');
      await answerPrompt(owner.page, 'Alpha');
      await owner.page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
      await owner.page.waitForFunction(() =>
        document.querySelector('[data-breadcrumb]')?.textContent?.includes('Alpha'),
      );
      assert.deepEqual(await crumbs(owner.page), ['Acme', 'Alpha']);

      await owner.page.click('app-team-page [data-action=new-project]'); // on a project page this makes a sub-project
      await answerPrompt(owner.page, 'Beta');
      await owner.page.waitForFunction(
        () => document.querySelectorAll('[data-breadcrumb] a').length === 3,
      );
      assert.deepEqual(await crumbs(owner.page), ['Acme', 'Alpha', 'Beta']);

      const beta = owner.page.locator('[data-project-tree] [data-project="Beta"]');
      const alpha = owner.page.locator('[data-project-tree] [data-project="Alpha"]');
      const indent = async (loc) =>
        loc.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
      assert.ok(
        (await indent(beta)) > (await indent(alpha)),
        'Beta is nested under Alpha in the tree',
      );

      // --- move Beta to the top level through the menu
      await beta.hover();
      await beta.locator('[data-project-menu]').click();
      await owner.page.click('[data-action=move]');
      await owner.page.click('button[role=option][data-target="Top level"]');
      await owner.page.waitForFunction(
        () => document.querySelectorAll('[data-breadcrumb] a').length === 2,
      );
      assert.deepEqual(await crumbs(owner.page), ['Acme', 'Beta']);
      assert.equal(await indent(beta), await indent(alpha), 'both are at the top level now');

      // --- and back under Alpha by dragging
      await beta.dragTo(alpha);
      await owner.page.waitForFunction(
        () => document.querySelectorAll('[data-breadcrumb] a').length === 3,
      );
      assert.deepEqual(await crumbs(owner.page), ['Acme', 'Alpha', 'Beta']);

      // --- another member sees the same tree after the next sync (here: both projects shared with them)
      const maxId = await userId(member.email);
      const teamId = teamPath.split('/').pop();
      await sql('INSERT INTO `TeamMember` (teamId, userId, joinedAt) VALUES (?, ?, NOW(3))', [
        teamId,
        maxId,
      ]);
      for (const name of ['Alpha', 'Beta'])
        await sql(
          'INSERT INTO `ProjectMember` (projectId, userId, joinedAt) VALUES (?, ?, NOW(3))',
          [await projectId(name), maxId],
        );
      await member.page.reload();
      await member.page.locator('app-rail [data-team="Acme"]').click();
      await member.page.waitForSelector('[data-team-sidebar]');
      await member.page.waitForSelector('[data-project-tree] [data-project="Beta"]');
      const mBeta = member.page.locator('[data-project-tree] [data-project="Beta"]');
      const mAlpha = member.page.locator('[data-project-tree] [data-project="Alpha"]');
      assert.ok(
        (await indent(mBeta)) > (await indent(mAlpha)),
        'the member sees Beta under Alpha, too',
      );
      assert.equal(
        await member.page.locator('app-team-page [data-action=new-project]').count(),
        0,
        'a member without the permission has no create button',
      );

      assert.deepEqual(
        [...admin.problems, ...owner.problems, ...member.problems, ...stranger.problems],
        [],
      );
      await Promise.all([admin.close(), owner.close(), member.close(), stranger.close()]);
    },
  );

  test(
    'the team and its projects open offline; a team the person lost disappears on the next sync',
    T,
    async () => {
      const owner = await account('Pia Owner');
      const member = await account('Tom Team');

      // an administrator makes the team
      const boss = await account('Boss', ADMIN_EMAIL_2);
      await boss.page.goto(`${base}/app/admin`);
      await boss.page.waitForSelector('[data-admin-teams]');
      await boss.page.fill('input[name=teamName]', 'Zeta');
      await boss.page.fill('input[name=teamOwner]', owner.email);
      await boss.page.click('[data-create-team]');
      await boss.page.locator('[data-team-row="Zeta"]').waitFor();

      await owner.page.reload();
      await owner.page.locator('app-rail [data-team="Zeta"]').click();
      await owner.page.waitForSelector('[data-team-page]');
      const teamId = new URL(owner.page.url()).pathname.split('/').pop();
      await owner.page.click('app-team-page [data-action=new-project]');
      await answerPrompt(owner.page, 'Gamma');
      await owner.page.waitForURL(/\/p\/[0-9a-f-]{36}$/);

      const memberId = await userId(member.email);
      await sql('INSERT INTO `TeamMember` (teamId, userId, joinedAt) VALUES (?, ?, NOW(3))', [
        teamId,
        memberId,
      ]);
      await sql('INSERT INTO `ProjectMember` (projectId, userId, joinedAt) VALUES (?, ?, NOW(3))', [
        await projectId('Gamma'),
        memberId,
      ]);

      // online once, so the device holds the tree
      await member.page.reload();
      await member.page.locator('app-rail [data-team="Zeta"]').click();
      await member.page.waitForSelector('[data-project-tree] [data-project="Gamma"]');
      await waitForOfflineReady(member.page);
      await member.page.reload();
      await member.page.waitForSelector('[data-project-tree] [data-project="Gamma"]');

      // offline: the rail, the team and the project tree come from the local database
      await member.ctx.setOffline(true);
      await member.page.reload();
      await member.page.waitForSelector('app-rail [data-team="Zeta"]', { timeout: 30_000 });
      await member.page.waitForSelector('[data-project-tree] [data-project="Gamma"]', {
        timeout: 30_000,
      });
      assert.equal(await member.page.locator('[data-title]').innerText(), 'Zeta');
      await member.page.locator('[data-project-tree] [data-project="Gamma"] a.name').click();
      await member.page.waitForFunction(
        () => document.querySelector('[data-title]')?.textContent?.trim() === 'Gamma',
      );
      assert.deepEqual(await crumbs(member.page), ['Zeta', 'Gamma']);
      await member.ctx.setOffline(false);

      // the person is removed from the team; the next sync takes it away from this device
      await sql('DELETE FROM `TeamMember` WHERE teamId = ? AND userId = ?', [teamId, memberId]);
      await member.page.click('button.chip');
      await member.page.waitForFunction(
        () => !document.querySelector('app-rail [data-team="Zeta"]'),
        null,
        { timeout: 30_000 },
      );
      await member.page.waitForSelector('app-not-found');

      assert.deepEqual([...owner.problems, ...member.problems, ...boss.problems], []);
      await Promise.all([owner.close(), member.close(), boss.close()]);
    },
  );
});
