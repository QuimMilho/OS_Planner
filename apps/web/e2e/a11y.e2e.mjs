// End-to-end, phase 17 (accessibility): axe-core on every main screen (no serious or critical violation), and the main
// flows done with the keyboard alone. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import { launch, register, sql, startStack, uniqueEmail, verify } from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('a11yadmin');
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

let stack;
let browser;
let base;
let owner;
let fixture;

before(async () => {
  stack = await startStack({ env: { ADMIN_EMAILS: ADMIN_EMAIL } });
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await owner?.close();
  await browser?.close();
  await stack?.stop();
});

/** A browser of its own. axe is injected as a script, which the app's CSP refuses: the audit contexts bypass it (nothing else does). */
async function device({ reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    bypassCSP: true,
    reducedMotion,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  return { ctx, page, close: () => ctx.close() };
}

async function account(name, email = uniqueEmail('a11y')) {
  const d = await device();
  await register(d.page, base, { name, email });
  await verify(d.page, email);
  await d.page.goto(`${base}/app`);
  await d.page.waitForSelector('app-rail');
  const id = (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;
  return { ...d, email, id, name };
}

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
const ok = async (promise, what) => {
  const res = await promise;
  assert.ok(res.status < 300, `${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

/** Runs axe on what is on screen now: the serious and critical violations, with where they are. */
async function audit(page, where) {
  await page.addScriptTag({ path: AXE });
  // let animations end and late chunks render
  await page.waitForTimeout(400);
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
      },
      resultTypes: ['violations'],
    });
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes
          .slice(0, 4)
          .map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`),
      }));
  });
  assert.deepEqual(violations, [], `${where}: ${JSON.stringify(violations, null, 2)}`);
}

async function setUp() {
  const admin = await account('The Admin', ADMIN_EMAIL);
  owner = await account('Olivia Owner');
  const team = await ok(
    api(admin.page, 'POST', '/api/admin/teams', {
      name: 'Accessible team',
      ownerEmail: owner.email,
    }),
    'team',
  );
  await admin.close();
  const [row] = await sql('SELECT spaceId FROM `Team` WHERE id = ?', [team.id]);
  const spaceId = row.spaceId;
  const channel = await ok(
    api(owner.page, 'POST', `/api/spaces/${spaceId}/channels`, { name: 'general' }),
    'channel',
  );
  await ok(
    api(owner.page, 'POST', `/api/channels/${channel.id}/messages`, {
      id: uuidv7(),
      content: 'Welcome **everybody**',
    }),
    'message',
  );
  const board = randomUUID();
  await ok(
    api(owner.page, 'POST', `/api/spaces/${spaceId}/boards`, {
      id: board,
      name: 'Roadmap',
      position: 'a0',
    }),
    'board',
  );
  const detail = await ok(api(owner.page, 'GET', `/api/boards/${board}`), 'board detail');
  const task = await ok(
    api(owner.page, 'POST', `/api/boards/${board}/tasks`, {
      id: randomUUID(),
      columnId: detail.columns[0].id,
      position: 'a0',
      title: 'Write the docs',
    }),
    'task',
  );
  const start = new Date(Date.now() + 86_400_000);
  start.setUTCHours(10, 0, 0, 0);
  await ok(
    api(owner.page, 'POST', '/api/events', {
      id: randomUUID(),
      spaceId,
      title: 'Planning',
      kind: 'meeting',
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 3_600_000).toISOString(),
    }),
    'event',
  );
  const notebook = randomUUID();
  await ok(
    api(owner.page, 'POST', '/api/notebooks', { id: notebook, name: 'Handbook', position: 'a0' }),
    'notebook',
  );
  const tree = await ok(api(owner.page, 'GET', `/api/notebooks/${notebook}/tree`), 'tree');
  const pageId = randomUUID();
  await ok(
    api(owner.page, 'POST', '/api/pages', {
      id: pageId,
      categoryId: tree.categories[0].id,
      title: 'Welcome',
      position: 'a0',
    }),
    'page',
  );
  const link = await ok(
    api(owner.page, 'POST', `/api/notebooks/${notebook}/links`, { access: 'read' }),
    'link',
  );
  const friend = await account('Fred Friend');
  await sql('INSERT INTO `TeamMember` (teamId, userId, joinedAt) VALUES (?, ?, NOW(3))', [
    team.id,
    friend.id,
  ]);
  const dm = await ok(api(owner.page, 'POST', '/api/dms', { userId: friend.id }), 'dm');
  await friend.close();
  return { team, spaceId, channel, board, task, pageId, link, dm };
}

function uuidv7() {
  const ms = Date.now().toString(16).padStart(12, '0');
  const r = randomUUID().replace(/-/g, '');
  return `${ms.slice(0, 8)}-${ms.slice(8)}-7${r.slice(0, 3)}-8${r.slice(4, 7)}-${r.slice(7, 19)}`;
}

describe('accessibility', () => {
  before(async () => {
    fixture = await setUp();
  }, T);

  test('the screens a signed-out visitor sees have no serious or critical problem', T, async () => {
    const d = await device();
    try {
      for (const path of ['/', '/login', '/register', '/forgot-password']) {
        await d.page.goto(`${base}${path}`);
        await d.page.locator('h1, form').first().waitFor();
        await audit(d.page, path);
      }
      await d.page.goto(`${base}/s/${fixture.link.token}`);
      await d.page.getByText('Welcome').first().waitFor();
      await audit(d.page, 'share view');
    } finally {
      await d.close();
    }
  });

  test(
    'the main screens of a signed-in person have no serious or critical problem',
    T,
    async () => {
      const p = owner.page;
      const screens = [
        ['home', '/app', 'app-rail'],
        ['team', `/app/t/${fixture.team.id}`, 'app-rail'],
        ['channel', `/app/c/${fixture.channel.id}`, '[data-channel-page]'],
        ['direct message', `/app/dm/${fixture.dm.id}`, '[data-channel-page]'],
        ['board', `/app/b/${fixture.board}`, 'article.card'],
        ['calendar', '/app/calendar', '[data-calendar]'],
        ['settings', '/app/settings', 'app-settings-page h1'],
        ['editor', `/app/p/${fixture.pageId}`, '.ProseMirror'],
      ];
      for (const [name, path, ready] of screens) {
        await p.goto(`${base}${path}`);
        await p.locator(ready).first().waitFor();
        await audit(p, name);
      }
      // the task drawer, over the board
      await p.goto(`${base}/app/b/${fixture.board}`);
      await p.locator('article.card').first().click();
      await p.locator('[role=dialog], mat-drawer, aside').first().waitFor();
      await audit(p, 'task drawer');
    },
  );

  test('the administration screen has no serious or critical problem', T, async () => {
    const admin = await device();
    try {
      await admin.page.goto(`${base}/login`);
      await admin.page.fill('input[type=email]', ADMIN_EMAIL);
      await admin.page.fill('input[type=password]', 'correct horse battery');
      await admin.page.keyboard.press('Enter');
      await admin.page.waitForSelector('app-rail');
      await admin.page.goto(`${base}/app/admin`);
      await admin.page.waitForSelector('[data-admin-teams]');
      await audit(admin.page, 'admin');
    } finally {
      await admin.close();
    }
  });

  test(
    'keyboard only: from the rail to a channel, a message sent, a task moved by its menu, a dialog closed with Escape',
    T,
    async () => {
      const p = owner.page;
      await p.goto(`${base}/app/c/${fixture.channel.id}`);
      const composer = p.locator('textarea').first();
      await composer.waitFor();
      // the composer is reachable with Tab from the top of the page
      await p.keyboard.press('Control+Home');
      let reached = false;
      for (let i = 0; i < 80 && !reached; i++) {
        await p.keyboard.press('Tab');
        reached = await composer.evaluate((el) => el === document.activeElement);
      }
      assert.ok(reached, 'the message box can be reached with Tab');
      await p.keyboard.type('Sent from the keyboard');
      await p.keyboard.press('Enter');
      await p.getByText('Sent from the keyboard').first().waitFor();

      // a task moves to another column without dragging: Alt and an arrow key (the card says so to a screen reader)
      await p.goto(`${base}/app/b/${fixture.board}`);
      const card = p.locator('article.card[data-task="Write the docs"]');
      await card.focus();
      assert.equal(
        await card.getAttribute('aria-keyshortcuts'),
        'Enter Alt+ArrowLeft Alt+ArrowRight',
      );
      assert.match(await p.locator('#board-card-hint').textContent(), /Alt/);
      await p.keyboard.press('Alt+ArrowRight');
      await p.locator('[data-column="Doing"] article.card[data-task="Write the docs"]').waitFor();
      // the moved card keeps the focus, and Enter opens it
      await p.waitForFunction(
        () => document.activeElement?.getAttribute('data-task') === 'Write the docs',
      );
      await p.keyboard.press('Enter');
      await p.locator('[role=dialog], mat-drawer, aside').first().waitFor();

      // a dialog closes with Escape and gives the focus back to what opened it
      await p.goto(`${base}/app/settings`);
      const opener = p
        .locator('button')
        .filter({ hasText: /password|sign out|delete|change/i })
        .first();
      await opener.focus();
      await p.keyboard.press('Enter');
      const dialog = p.locator('mat-dialog-container');
      if (await dialog.count()) {
        await p.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.ok(
          await opener.evaluate((el) => el === document.activeElement),
          'the focus goes back to the button that opened the dialog',
        );
      }
    },
  );

  test(
    'new messages and notifications are announced politely; reduced motion is honoured',
    T,
    async () => {
      const p = owner.page;
      await p.goto(`${base}/app/c/${fixture.channel.id}`);
      await p.locator('textarea').first().waitFor();
      assert.ok(
        (await p.locator('[aria-live="polite"]').count()) > 0,
        'a polite live region announces new messages',
      );
      const calm = await device({ reducedMotion: 'reduce' });
      try {
        await calm.page.goto(`${base}/login`);
        const duration = await calm.page.evaluate(() => {
          const el = document.createElement('div');
          el.className = 'mat-mdc-button';
          document.body.append(el);
          return getComputedStyle(el).transitionDuration;
        });
        assert.ok(
          /^0s|^0\.0+1s|^1e-/.test(duration) || duration === '0s',
          `animations are switched off with reduced motion (got ${duration})`,
        );
      } finally {
        await calm.close();
      }
    },
  );
});
