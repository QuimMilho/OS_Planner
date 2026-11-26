// Tests the Electron shell: it must show the real website, keep the session, save files through the
// native dialog, stay on the site, and cope with an unreachable server.
//   npm run test -w @os-planner/desktop      (needs `docker compose up -d mysql mailpit` and a build of web + server)
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { _electron as electron } from 'playwright-core';
import { createNotebookAndPage, register, startStack, verify, waitSaved, writePage } from '../../web/e2e/harness.mjs';

const T = { timeout: 180_000 };
const appDir = resolve(import.meta.dirname, '..');
let stack;
let base;

before(async () => {
  stack = await startStack();
  base = stack.baseUrl;
});
after(async () => stack?.stop());

/** Starts the app with its own profile folder, pointed at `serverUrl`. */
async function launchApp(userData, serverUrl) {
  mkdirSync(userData, { recursive: true });
  if (serverUrl) writeFileSync(join(userData, 'config.json'), JSON.stringify({ serverUrl }));
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: appDir, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  return { app, page };
}

describe('desktop shell', () => {
  test('shows the real website, exposes only the small bridge, and keeps the page sandboxed', T, async () => {
    const userData = mkdtempSync(join(tmpdir(), 'os-planner-desktop-'));
    const { app, page } = await launchApp(userData, base);
    try {
      await page.waitForSelector('h1');
      assert.match(await page.textContent('h1'), /Plans that go as far as your ideas/);
      assert.equal(await page.title(), 'OS_Planner');

      const probe = await page.evaluate(() => ({
        bridge: window.osPlannerDesktop && { isDesktop: window.osPlannerDesktop.isDesktop, keys: Object.keys(window.osPlannerDesktop).sort() },
        config: typeof window.osPlannerConfig, // only the bundled local pages get this
        require: typeof window.require,
        process: typeof window.process,
        fs: typeof window.fs,
      }));
      assert.deepEqual(probe.bridge, { isDesktop: true, keys: ['isDesktop', 'onMenuCommand', 'platform', 'saveFile', 'version'] });
      assert.equal(probe.config, 'undefined');
      assert.equal(probe.require, 'undefined');
      assert.equal(probe.process, 'undefined');
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });

  test('signing in works, and the session and notes survive quitting and relaunching', T, async () => {
    const userData = mkdtempSync(join(tmpdir(), 'os-planner-desktop-'));
    let first = await launchApp(userData, base);
    try {
      await first.page.goto(`${base}/register`);
      const { email } = await register(first.page, base);
      await createNotebookAndPage(first.page, 'Desktop');
      await writePage(first.page, 'Written on the desktop', 'These notes live in the app window.');
      await waitSaved(first.page);
      void email;
    } finally {
      await first.app.close();
    }

    const second = await launchApp(userData, base);
    try {
      await second.page.goto(`${base}/app`);
      await second.page.waitForSelector('app-shell'); // no sign-in screen: the cookie persisted
      await second.page.waitForSelector('app-tree-category .row.page:has-text("Written on the desktop")');
    } finally {
      await second.app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });

  test('the window opens the live connection and reacts to an event the server pushes', T, async () => {
    const userData = mkdtempSync(join(tmpdir(), 'os-planner-desktop-'));
    const { app, page } = await launchApp(userData, base);
    try {
      await register(page, base);
      await page.waitForSelector('[data-realtime][data-status="connected"]', { timeout: 30_000 });

      // Something changes in the person's space without the app asking (a request made from outside the app's own
      // sync): the server announces it on the socket, and the app pulls at once instead of waiting for its 60 s timer.
      const pulls = [];
      page.on('request', (r) => r.url().includes('/api/sync/changes') && pulls.push(Date.now()));
      await page.waitForTimeout(3000); // the first sync cycles settle
      const before = pulls.length;
      const created = await page.evaluate(async () => {
        const refresh = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'X-Requested-With': 'os_planner' } });
        const { accessToken } = await refresh.json();
        const res = await fetch('/api/notebooks', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: crypto.randomUUID(), name: 'Pushed', position: 'a0' }),
        });
        return res.status;
      });
      assert.equal(created, 201);
      for (let i = 0; i < 40 && pulls.length === before; i++) await page.waitForTimeout(250);
      assert.ok(pulls.length > before, 'the app pulled after the push, well before its 60 s timer');
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });

  test('"Save as" goes through the native dialog and writes the real file', T, async () => {
    const userData = mkdtempSync(join(tmpdir(), 'os-planner-desktop-'));
    const out = join(userData, 'exported.pdf');
    const { app, page } = await launchApp(userData, base);
    try {
      const { email } = await register(page, base);
      await verify(page, email);
      await page.goto(`${base}/app`);
      await createNotebookAndPage(page, 'Export');
      await writePage(page, 'Desktop export', 'Exported from the desktop app.');
      await waitSaved(page, 40_000);

      // stand in for the human choosing a file name in the dialog
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, out);

      await page.click('button.export-btn');
      await page.waitForSelector('app-export-dialog');
      await page.click('app-export-dialog button:has-text("Export")');
      await page.waitForFunction(() => !document.querySelector('app-export-dialog'), null, { timeout: 60_000 });
      for (let i = 0; i < 40 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 250));
      assert.ok(existsSync(out), 'the file was written');
      assert.equal(readFileSync(out).subarray(0, 5).toString(), '%PDF-');
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });

  test('links to other sites open outside the app, and the window never leaves the OS_Planner site', T, async () => {
    const userData = mkdtempSync(join(tmpdir(), 'os-planner-desktop-'));
    const { app, page } = await launchApp(userData, base);
    try {
      await page.waitForSelector('h1');
      const external = [];
      await app.evaluate(({ shell }) => {
        globalThis.__opened = [];
        shell.openExternal = async (url) => void globalThis.__opened.push(url);
      });
      await page.evaluate(() => {
        const a = document.createElement('a');
        a.href = 'https://example.org/somewhere';
        a.target = '_blank';
        a.id = 'ext';
        a.textContent = 'external';
        document.body.append(a);
        a.click();
        const b = document.createElement('a');
        b.href = 'https://example.org/same-tab';
        b.click();
      });
      await new Promise((r) => setTimeout(r, 1000));
      const opened = await app.evaluate(() => globalThis.__opened);
      external.push(...opened);
      assert.ok(external.includes('https://example.org/somewhere'));
      assert.ok(external.includes('https://example.org/same-tab'));
      assert.match(page.url(), new RegExp(`^${base}`), 'the window stayed on the OS_Planner site');
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });

  test('an unreachable server shows a friendly page instead of a blank window', T, async () => {
    const userData = mkdtempSync(join(tmpdir(), 'os-planner-desktop-'));
    const { app, page } = await launchApp(userData, 'http://127.0.0.1:9');
    try {
      await page.waitForSelector('text=Can’t reach OS_Planner');
      assert.match(await page.textContent('#server'), /127\.0\.0\.1:9/);
      assert.equal(await page.evaluate(() => typeof window.osPlannerConfig), 'object'); // the local page can change the server
      assert.equal(await page.evaluate(() => typeof window.osPlannerConfig.openSettings), 'function');
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
