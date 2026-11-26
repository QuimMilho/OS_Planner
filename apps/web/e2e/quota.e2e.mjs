// End-to-end: storage quota and the admin area. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  apiGet,
  createNotebookAndPage,
  launch,
  makeNoisePng,
  register,
  startStack,
  uniqueEmail,
  verify,
  waitSaved,
  writePage,
} from './harness.mjs';

const T = { timeout: 180_000 };
const ADMIN_EMAIL = uniqueEmail('admin');
const LIMIT_MB = 0.25; // 262 144 bytes

let stack;
let browser;
let base;

before(async () => {
  stack = await startStack({ env: { ADMIN_EMAILS: ADMIN_EMAIL, USER_QUOTA_MB: String(LIMIT_MB) } });
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

const insertImage = async (page, name, buffer) => {
  await page.click('button:has-text("Insert")');
  await page.click('button[role=menuitem]:has-text("Image")');
  await page.setInputFiles('input[type=file]', { name, mimeType: 'image/png', buffer });
};

/** Runs a request from inside the page, with a fresh access token. */
const api = (page, path) =>
  page.evaluate(async (p) => {
    const r = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'X-Requested-With': 'os_planner' },
    });
    const { accessToken } = await r.json();
    return (await fetch(p, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
  }, path);

const openPage = async (page, title) => {
  await page.goto(`${base}/app`);
  await page.locator('app-tree-category .row.page', { hasText: title }).click();
  await page.waitForSelector('.ProseMirror.doc');
  await page.locator('.ProseMirror').focus();
  await page.keyboard.press('Control+End');
};

describe('storage quota', () => {
  test(
    'the usage bar follows an upload; at the limit the person is told, the file waits, and text still saves',
    T,
    async () => {
      const { page, problems, close } = await device();
      const { email } = await register(page, base);
      await verify(page, email);
      await page.goto(`${base}/app`);

      await createNotebookAndPage(page, 'Storage');
      await writePage(page, 'Quota page', 'before the limit');
      await waitSaved(page);

      // Settings → Storage starts nearly empty and shows the limit.
      await page.goto(`${base}/app/settings`);
      await page.waitForSelector('[data-usage]');
      assert.equal(await page.locator('[data-kind=images] .muted').innerText(), '0.00 MB');
      assert.equal(await page.locator('[data-limit]').innerText(), '0.25');

      // A picture that fits: the bar and the image figure both move.
      await openPage(page, 'Quota page');
      await insertImage(page, 'small.png', await makeNoisePng(100)); // ~30 KB
      await page.waitForSelector('app-image-figure-view img');
      await waitSaved(page, 40_000);
      await page.waitForFunction(
        async () => {
          const r = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'X-Requested-With': 'os_planner' },
          });
          const { accessToken } = await r.json();
          const usage = await (
            await fetch('/api/me/storage', { headers: { Authorization: `Bearer ${accessToken}` } })
          ).json();
          return usage.images > 0;
        },
        null,
        { timeout: 40_000, polling: 1000 },
      );

      await page.goto(`${base}/app/settings`);
      await page.waitForSelector('[data-kind=images]');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-kind=images] .muted')?.textContent?.trim() !== '0.00 MB',
        null,
        { timeout: 20_000 },
      );
      assert.ok(Number(await page.locator('[data-used]').innerText()) > 0);

      // A picture bigger than everything that is left: refused as a whole, with a message that says why.
      await openPage(page, 'Quota page');
      await insertImage(page, 'huge.png', await makeNoisePng(400)); // ~480 KB, more than the whole limit
      await page.waitForSelector('[data-quota-banner]', { timeout: 40_000 });
      await page.waitForSelector('text=Your storage is full', { timeout: 40_000 });

      // The text keeps saving: typing more still reaches the server.
      await page.locator('.ProseMirror').focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' and after the limit');
      await waitSaved(page, 40_000);
      const id = (await apiGet(page, '/api/pages')).body.find((p) => p.title === 'Quota page').id;
      await page.waitForFunction(
        async (pid) => {
          const r = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'X-Requested-With': 'os_planner' },
          });
          const { accessToken } = await r.json();
          const doc = await (
            await fetch(`/api/pages/${pid}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            })
          ).json();
          return JSON.stringify(doc.content).includes('and after the limit');
        },
        id,
        { timeout: 40_000, polling: 1000 },
      );

      // Nothing of the refused picture reached the server's storage.
      const usage = await api(page, '/api/me/storage');
      assert.ok(usage.used < usage.limit);
      assert.ok(usage.images < 100_000, `only the small picture is stored, got ${usage.images}`);
      assert.deepEqual(problems, []);
      await close();
    },
  );
});

describe('administration', () => {
  test(
    "an admin raises another account's limit and it applies without that person signing in again; a non-admin gets the not-found page",
    T,
    async () => {
      const admin = await device();
      await register(admin.page, base, { email: ADMIN_EMAIL, name: 'The Admin' });
      await verify(admin.page, ADMIN_EMAIL);
      await admin.page.goto(`${base}/app`);

      const bEmail = uniqueEmail('b');
      const b = await device();
      await register(b.page, base, { email: bEmail, name: 'Bea Member' });
      await b.page.goto(`${base}/app/settings`);
      await b.page.waitForSelector('[data-limit]');
      assert.equal(await b.page.locator('[data-limit]').innerText(), '0.25');
      assert.equal(
        await b.page.locator('[data-nav=admin]').count(),
        0,
        'no admin link for an ordinary account',
      );

      // A non-admin who types the address gets the same page as for any unknown address.
      await b.page.goto(`${base}/admin`);
      await b.page.waitForSelector('app-not-found');
      assert.match(b.page.url(), /\/app\/admin$/);
      assert.equal(await b.page.locator('app-admin-page').count(), 0);

      // The admin finds the account and raises its limit to 5 MB.
      await admin.page.click('[data-nav=admin]');
      await admin.page.waitForSelector('app-admin-page');
      await admin.page.waitForSelector('[data-stat=users]');
      await admin.page.fill('input[name=q]', bEmail);
      const row = admin.page.locator(`tr[data-user="${bEmail}"]`);
      await row.waitFor();
      await row.locator('[data-edit]').click();
      await admin.page.fill('input[name=storage]', '5');
      await admin.page.click('[data-save]');
      await admin.page.waitForSelector(`tr[data-user="${bEmail}"] .tag`);
      assert.equal(await row.locator('[data-limit]').innerText(), '5');

      // B navigates (no new sign-in): the new limit shows.
      await b.page.goto(`${base}/app/settings`);
      await b.page.waitForFunction(
        () => document.querySelector('[data-limit]')?.textContent?.trim() === '5.00',
      );

      // The admin can put the default back.
      await row.locator('[data-edit]').click();
      await admin.page.click('[data-clear]');
      await admin.page.waitForFunction(
        (sel) => !document.querySelector(sel),
        `tr[data-user="${bEmail}"] .tag`,
      );

      assert.deepEqual([...admin.problems, ...b.problems], []);
      await admin.close();
      await b.close();
    },
  );
});
