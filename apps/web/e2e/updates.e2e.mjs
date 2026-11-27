// End-to-end: the installed website updates itself without asking, but never while something would be lost.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
//
// The server serves a *copy* of the web build, and a new version is made by changing that copy's ngsw.json
// (appData): the service worker sees a different manifest, downloads it (every file is already cached) and
// reports a ready version, exactly as for a real release.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { launch, register, ROOT, startStack, waitForOfflineReady } from './harness.mjs';

const T = { timeout: 240_000 };
let stack;
let browser;
let base;
let webCopy;

before(async () => {
  webCopy = mkdtempSync(join(tmpdir(), 'os-planner-web-'));
  cpSync(resolve(ROOT, 'apps/web/dist/web/browser'), webCopy, { recursive: true });
  stack = await startStack({ env: { WEB_DIST_DIR: webCopy } });
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await stack?.stop();
  if (webCopy) rmSync(webCopy, { recursive: true, force: true });
});

/** Publishes "a new release": same files, a different manifest. */
function release(label) {
  const file = join(webCopy, 'ngsw.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.appData = { ...manifest.appData, release: label };
  writeFileSync(file, JSON.stringify(manifest));
}

/** A signed-in device with the service worker in control of the page. */
async function installedApp() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  await register(page, base);
  await waitForOfflineReady(page);
  await page.reload();
  await page.waitForSelector('app-shell');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return { ctx, page };
}

/** Looks for a new version, as the app does when it comes to the front. */
const checkNow = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

describe('automatic updates of the installed website', () => {
  test('a new version is switched to by itself when the person moves to another page, and the app says so', T, async () => {
    const { ctx, page } = await installedApp();
    try {
      await page.evaluate(() => (window.__mark = 1));
      release('v2');
      await checkNow(page);

      // The download takes a moment; the app waits for a page change, so keep changing pages until it reloads.
      let reloaded = false;
      for (let i = 0; i < 40 && !reloaded; i++) {
        try {
          if (await page.evaluate(() => window.__mark === undefined)) reloaded = true;
          else await page.click(`a[data-nav="${i % 2 ? 'calendar' : 'my-tasks'}"]`, { timeout: 2000 });
        } catch {
          /* the page is reloading */
        }
        if (!reloaded) await page.waitForTimeout(1000);
      }
      assert.ok(reloaded, 'the page was reloaded with the new version');
      await page.waitForSelector('app-shell'); // still signed in
      await page.waitForSelector('text=OS_Planner was updated.');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('os_planner.updated')), null, 'the note is used up');
    } finally {
      await ctx.close();
    }
  });

  test('it waits while a dialog is open, and updates a window that is out of sight once the dialog is closed', T, async () => {
    const { ctx, page } = await installedApp();
    try {
      await page.click('a[data-nav="calendar"]');
      await page.click('button[data-action="new-event"]');
      await page.waitForSelector('mat-dialog-container');
      await page.evaluate(() => (window.__mark = 1));

      release('v3');
      await checkNow(page);
      await page.waitForTimeout(4000); // downloaded and waiting

      // the window goes to the background (the tab is hidden)
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(20_000); // longer than the 15 s a hidden window must wait
      assert.equal(await page.evaluate(() => window.__mark), 1, 'the open dialog held the update back');

      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.__mark === undefined, null, { timeout: 40_000 });
      await page.waitForSelector('app-shell');
    } finally {
      await ctx.close();
    }
  });
});
