// The "get the app from the website" promise, end to end, with the real installers:
// publish them to a server, see them on its download page, download one, and run the packaged app.
// Skipped when no installers have been built (run `npm run dist:win -w @notes/desktop` first).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { _electron as electron } from 'playwright-core';
import { RELEASE_TOKEN, ROOT, launch, startStack } from '../../web/e2e/harness.mjs';

const releaseDir = resolve(ROOT, 'apps/desktop/release');
const version = JSON.parse(readFileSync(resolve(ROOT, 'apps/desktop/package.json'), 'utf8')).version;
const haveWindowsBuild = existsSync(join(releaseDir, `Notes-${version}-win-x64-setup.exe`));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

let stack;
let base;
before(async () => {
  stack = await startStack();
  base = stack.baseUrl;
});
after(async () => stack?.stop());

describe('desktop releases', { skip: !haveWindowsBuild && 'no installers built' }, () => {
  test('publishing lists the real builds on the download page with correct checksums, and the download is intact', { timeout: 600_000 }, async () => {
    const out = execFileSync(process.execPath, [resolve(ROOT, 'scripts/publish-desktop.mjs')], {
      env: { ...process.env, NOTES_SERVER_URL: base, RELEASE_TOKEN, RELEASE_NOTES: 'Release from the end-to-end test' },
      encoding: 'utf8',
    });
    assert.match(out, /Published\./);

    const { release } = await (await fetch(`${base}/api/downloads`)).json();
    assert.equal(release.version, version);
    const nsis = release.files.find((f) => f.format === 'nsis');
    const portable = release.files.find((f) => f.format === 'portable');
    assert.ok(nsis && portable, 'both Windows builds are listed');
    assert.equal(nsis.sha256, sha256(join(releaseDir, nsis.name)), 'the server computed the checksum of what it holds');
    assert.equal(nsis.size, statSync(join(releaseDir, nsis.name)).size);

    // installed apps update from the same place
    const feed = await fetch(`${base}/downloads/latest.yml`);
    assert.equal(feed.status, 200);
    assert.match(await feed.text(), new RegExp(`version: ${version.replace(/\./g, '\\.')}`));

    // a person downloading it from the website gets the identical file
    const browser = await launch();
    try {
      const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(`${base}/download`);
      await page.waitForSelector(`text=${version}`);
      await page.waitForSelector('text=Release from the end-to-end test');
      assert.match(await page.textContent('app-apps-panel'), /Installer \(\.exe\)/);
      assert.match(await page.textContent('app-apps-panel'), /SmartScreen/); // the unsigned-installer heads-up
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.click('a:has-text("Download for Windows")')]);
      assert.equal(download.suggestedFilename(), nsis.name);
      assert.equal(sha256(await download.path()), nsis.sha256);
    } finally {
      await browser.close();
    }
  });

  test('the packaged app (not the development one) starts, shows the website and is sandboxed', { timeout: 120_000, skip: process.platform !== 'win32' && 'the unpacked build here is for Windows' }, async () => {
    const exe = join(releaseDir, 'win-unpacked', 'Notes.exe');
    const userData = mkdtempSync(join(tmpdir(), 'notes-packaged-'));
    // A real install shows the server baked in at build time; here the person has chosen the test server.
    writeFileSync(join(userData, 'config.json'), JSON.stringify({ serverUrl: base }));
    const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`] });
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(30_000);
      await page.waitForSelector('h1');
      assert.match(await page.textContent('h1'), /Notes that go as far as your ideas/);
      assert.equal(await app.evaluate(({ app: a }) => a.isPackaged), true);
      assert.ok(readdirSync(join(releaseDir, 'win-unpacked', 'resources')).includes('app.asar'), 'the app is packed into an asar archive');
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      assert.equal(await page.evaluate(() => window.notesDesktop?.isDesktop), true);
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
