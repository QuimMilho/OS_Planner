// End-to-end tests: the real web app in real Chrome, against the real server, MySQL and mail catcher.
//   npm run e2e          (from the repo root; needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  PASSWORD, RELEASE_TOKEN, ROOT, apiGet, createNotebookAndPage, launch, linkIn, login, makePng, register, startStack,
  uniqueEmail, verify, waitForMail, waitForOfflineReady, waitSaved, writePage,
} from './harness.mjs';

const T = { timeout: 180_000 };
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

/** A fresh browser profile ("a device"). Collects anything the strict CSP blocks. */
async function device(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, ...options });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const violations = [];
  page.on('console', (m) => /Content Security Policy|violates the following/i.test(m.text()) && violations.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message.slice(0, 200)}`));
  return { ctx, page, violations, close: async () => ctx.close() };
}

const slash = async (page, query) => {
  await page.keyboard.type(`/${query}`);
  await page.waitForSelector('.slash button');
  await page.keyboard.press('Enter');
};
/**
 * Puts the caret at the end of the document. Focuses the editor instead of clicking it: a click in the
 * middle can land on a diagram, chart or one of their source boxes, and typing would go there.
 */
const endOfDoc = async (page) => {
  await page.locator('.ProseMirror').focus();
  await page.keyboard.press('Control+End');
};

/** Runs one phase of a long test; a failure names the phase and leaves a screenshot in e2e/.artifacts. */
const phase = async (page, label, fn) => {
  try {
    return await fn();
  } catch (e) {
    await page.screenshot({ path: resolve(ROOT, 'apps/web/e2e/.artifacts', `${label.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
    e.message = `[${label}] ${e.message}`;
    throw e;
  }
};
const treeItem = (page, text) => page.locator('app-tree-category .row.page', { hasText: text });

describe('accounts', () => {
  test('register, confirm the email, sign out and sign in again', T, async () => {
    const { page, violations, close } = await device();
    const { email } = await register(page, base);
    await page.waitForSelector('text=Please confirm your email');

    await verify(page, email);
    await page.goto(`${base}/app`);
    await page.waitForSelector('app-shell');
    assert.equal(await page.locator('text=Please confirm your email').count(), 0, 'the banner goes away once confirmed');

    await page.click('button[aria-label="Account"]');
    await page.click('text=Sign out');
    await page.waitForURL(`${base}/`);

    await login(page, base, email);
    assert.deepEqual(violations, []);
    await close();
  });

  test('a wrong password is refused with a clear message, and /app asks to sign in first', T, async () => {
    const { page, close } = await device();
    const { email } = await register(page, base);
    await page.click('button[aria-label="Account"]');
    await page.click('text=Sign out');
    await page.waitForURL(`${base}/`);

    await page.goto(`${base}/app`);
    await page.waitForURL(/\/login\?returnUrl=%2Fapp/);
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', 'definitely the wrong one');
    await page.click('button[type=submit]');
    await page.waitForSelector('text=That email or password is not right');

    await page.fill('input[name=password]', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL('**/app'); // sent back to where they were going
    await close();
  });

  test('forgot password: the mailed link sets a new password and the old one stops working', T, async () => {
    const { page, close } = await device();
    const { email } = await register(page, base);
    await page.click('button[aria-label="Account"]');
    await page.click('text=Sign out');
    await page.waitForURL(`${base}/`);

    await page.goto(`${base}/forgot-password`);
    await page.fill('input[name=email]', email);
    await page.click('button[type=submit]');
    await page.waitForSelector('text=a reset link is on its way');
    const link = linkIn(await waitForMail(email, 'Reset'));

    await page.goto(link);
    await page.fill('input[name=password]', 'a brand new passphrase');
    await page.click('button[type=submit]');
    await page.waitForSelector('text=Your password was changed');

    await page.goto(`${base}/login`);
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForSelector('text=That email or password is not right');
    await page.fill('input[name=password]', 'a brand new passphrase');
    await page.click('button[type=submit]');
    await page.waitForURL('**/app');

    // the link cannot be used twice
    await page.goto(link);
    await page.fill('input[name=password]', 'yet another passphrase');
    await page.click('button[type=submit]');
    await page.waitForSelector('text=invalid or has expired');
    await close();
  });
});

describe('notebooks, categories and pages', () => {
  test('create, nest, rename, move to trash and restore, and everything survives a reload', T, async () => {
    const { page, close } = await device();
    await register(page, base);
    await createNotebookAndPage(page, 'Physics');
    await writePage(page, 'Kinematics', 'Velocity is the rate of change of position.');
    await waitSaved(page);

    // a category inside the notebook, renamed inline
    const nb = page.locator('app-tree .row.nb', { hasText: 'Physics' });
    await nb.hover();
    await nb.locator('button[aria-label="New category"]').click();
    await page.waitForSelector('app-inline-name input.edit');
    await page.keyboard.type('Dynamics');
    await page.keyboard.press('Enter');
    await page.waitForSelector('app-tree-category .row:has-text("Dynamics")');

    // everything keeps its name after a reload
    await page.reload();
    await page.waitForSelector('app-tree-category .row:has-text("Dynamics")');
    assert.equal(await page.inputValue('input.title'), 'Kinematics');
    assert.match(await page.textContent('.ProseMirror'), /Velocity is the rate of change/);

    // delete the page -> it is in the trash -> restore it
    await treeItem(page, 'Kinematics').hover();
    await treeItem(page, 'Kinematics').locator('button[aria-label="More"]').click();
    await page.click('button[role=menuitem]:has-text("Delete")');
    await page.waitForSelector('text=moved to the trash');
    assert.equal(await treeItem(page, 'Kinematics').count(), 0);
    await page.click('a:has-text("Trash")');
    await page.waitForSelector('li:has-text("Kinematics")');
    await page.click('li:has-text("Kinematics") button:has-text("Restore")');
    await page.waitForSelector('text=The trash is empty');
    assert.equal(await treeItem(page, 'Kinematics').count(), 1);
    await close();
  });
});

describe('the editor', () => {
  test('headings, lists, code, tables, math, diagrams, charts and plots are saved and come back', T, async () => {
    const { page, violations, close } = await device();
    await register(page, base);
    await createNotebookAndPage(page, 'Everything');
    await writePage(page, 'Rich page', '');

    await phase(page, 'text blocks', async () => {
      await slash(page, 'heading 1');
      await page.keyboard.type('Overview');
      await page.keyboard.press('Enter');
      await slash(page, 'to-do');
      await page.keyboard.type('first task');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter'); // leave the list
      await slash(page, 'code');
      await page.keyboard.type('const answer = 42;');
      await endOfDoc(page);
      await slash(page, 'table');
      await endOfDoc(page);
      await page.keyboard.press('Enter');
    });

    await phase(page, 'diagram', async () => {
      await slash(page, 'diagram');
      await page.waitForSelector('app-mermaid-view .preview svg', { timeout: 30_000 });
      await endOfDoc(page);
      await page.keyboard.press('Enter');
    });
    await phase(page, 'chart', async () => {
      await slash(page, 'chart');
      await page.waitForSelector('app-chart-view canvas', { timeout: 30_000 });
      await endOfDoc(page);
      await page.keyboard.press('Enter');
    });
    await phase(page, 'plot', async () => {
      await slash(page, 'plot');
      await page.waitForSelector('app-plot-view .plot svg polyline');
      await endOfDoc(page);
      await page.keyboard.press('Enter');
    });
    await phase(page, 'equation', async () => {
      await slash(page, 'equation');
      await page.fill('app-math-dialog textarea', String.raw`\int_0^1 x^2\,dx = \tfrac{1}{3}`);
      await page.waitForSelector('app-math-dialog .katex');
      await page.click('app-math-dialog button:has-text("Save")');
      await page.waitForSelector('.ProseMirror .katex-display, .ProseMirror [data-type="block-math"] .katex');
    });

    await waitSaved(page);
    await page.reload();
    await page.waitForSelector('.ProseMirror.doc');
    const expected = ['h1:has-text("Overview")', 'ul[data-type="taskList"]', 'pre code', 'table', 'app-mermaid-view svg', 'app-chart-view canvas', 'app-plot-view svg polyline', '.katex'];
    const missing = [];
    for (const sel of expected) {
      // diagrams and charts load their drawing library on first use, so give each a moment
      await page.waitForSelector(`.ProseMirror ${sel}`, { timeout: 30_000 }).catch(() => missing.push(sel));
    }
    assert.deepEqual(missing, [], 'these blocks did not come back after a reload');
    assert.match(await page.textContent('pre code'), /const answer = 42;/);
    assert.deepEqual(violations, [], 'nothing may be blocked by the Content-Security-Policy');
    await close();
  });

  test('the plot is drawn from the expression, and a typo shows a message instead of breaking the page', T, async () => {
    const { page, violations, close } = await device();
    await register(page, base);
    await createNotebookAndPage(page, 'Plots');
    await writePage(page, 'Plot page', '');
    await slash(page, 'plot');
    await page.waitForSelector('app-plot-view .plot svg polyline');
    const before = await page.locator('app-plot-view polyline').first().getAttribute('points');

    await page.locator('app-plot-view input.f').first().fill('x^2 / 10');
    await page.waitForFunction((b) => document.querySelector('app-plot-view polyline')?.getAttribute('points') !== b, before);

    await page.locator('app-plot-view input.f').first().fill('x^2 +');
    await page.waitForSelector('app-plot-view .err, app-plot-view .problem');
    assert.deepEqual(violations, []);
    await close();
  });

  test('typing "/" offers commands ranked by relevance, and arrow keys + Enter pick one', T, async () => {
    const { page, close } = await device();
    await register(page, base);
    await createNotebookAndPage(page, 'Slash');
    await writePage(page, 'Slash page', '');
    await page.keyboard.type('/chart');
    await page.waitForSelector('.slash button');
    assert.match(await page.locator('.slash button').first().textContent(), /Chart/, 'the exact match comes first, not "flowchart" in Mermaid');
    await page.keyboard.press('Escape');
    await close();
  });

  test('the page title and an unsaved edit are never lost when switching pages quickly', T, async () => {
    const { page, close } = await device();
    await register(page, base);
    await createNotebookAndPage(page, 'Switch');
    await writePage(page, 'First', 'draft text that must survive');
    // leave immediately, before the autosave delay elapses
    const row = page.locator('app-tree-category .row', { hasText: 'General' }).first();
    await row.hover();
    await row.locator('button[aria-label="New page"]').click();
    await page.waitForSelector('input.title');
    await treeItem(page, 'First').click();
    await page.waitForFunction(() => /draft text that must survive/.test(document.querySelector('.ProseMirror')?.textContent ?? ''));
    await close();
  });
});

describe('images and sync', () => {
  test('an uploaded image is stored on the server and shows up on a second device', T, async () => {
    const a = await device();
    const { email } = await register(a.page, base);
    await verify(a.page, email); // uploads need a confirmed email
    await a.page.goto(`${base}/app`);
    await createNotebookAndPage(a.page, 'Pictures');
    await writePage(a.page, 'With image', 'Here is a picture:');

    await a.page.click('button:has-text("Insert")');
    await a.page.click('button[role=menuitem]:has-text("Image")');
    await a.page.setInputFiles('input[type=file]', { name: 'green.png', mimeType: 'image/png', buffer: await makePng(120, 80) });
    await a.page.waitForSelector('app-image-figure-view img');
    await waitSaved(a.page, 40_000);

    // the file reached the server (quota usage goes up)...
    await a.page.waitForFunction(async () => {
      const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'X-Requested-With': 'os_planner' } });
      const { accessToken } = await r.json();
      const me = await (await fetch('/api/me', { headers: { Authorization: `Bearer ${accessToken}` } })).json();
      return me.storageUsedBytes > 0;
    }, null, { timeout: 40_000, polling: 1000 });

    // ...and a brand-new device shows it, downloaded from the server
    const b = await device();
    await login(b.page, base, email);
    await treeItem(b.page, 'With image').click();
    const img = b.page.locator('app-image-figure-view img');
    await img.waitFor({ timeout: 30_000 });
    await b.page.waitForFunction(() => document.querySelector('app-image-figure-view img')?.naturalWidth === 120, null, { timeout: 30_000 });
    assert.deepEqual([...a.violations, ...b.violations], []);
    await a.close();
    await b.close();
  });

  test('images cannot be uploaded before the email is confirmed: they wait on the device and the user is told', T, async () => {
    const { page, close } = await device();
    await register(page, base);
    await createNotebookAndPage(page, 'Unverified');
    await writePage(page, 'Waiting', 'text');
    await page.click('button:has-text("Insert")');
    await page.click('button[role=menuitem]:has-text("Image")');
    await page.setInputFiles('input[type=file]', { name: 'x.png', mimeType: 'image/png', buffer: await makePng() });
    await page.waitForSelector('app-image-figure-view img');
    await page.waitForSelector('text=Confirm your email address to upload images', { timeout: 30_000 });
    await close();
  });

  test('a file that is not an image or video is refused with a message', T, async () => {
    const { page, close } = await device();
    await register(page, base);
    await createNotebookAndPage(page, 'Refuse');
    await writePage(page, 'Bad file', '');
    await page.click('button:has-text("Insert")');
    await page.click('button[role=menuitem]:has-text("Image")');
    await page.setInputFiles('input[type=file]', { name: 'notes.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await page.waitForSelector('text=is not a supported image or video');
    assert.equal(await page.locator('app-image-figure-view').count(), 0);
    await close();
  });
});

describe('working offline', () => {
  test('edits made offline are kept on the device, survive an offline reload, and reach the server when back online', T, async () => {
    const { ctx, page, close } = await device();
    const { email } = await register(page, base);
    await createNotebookAndPage(page, 'Offline');
    await writePage(page, 'Field notes', 'Written online.');
    await waitSaved(page);

    // the service worker takes a while to install and download the app; it must be cached before we cut the network
    await waitForOfflineReady(page);
    await page.reload();
    await page.waitForSelector('.ProseMirror.doc');

    await ctx.setOffline(true);
    await endOfDoc(page);
    await page.keyboard.type(' Written offline.');
    await page.waitForFunction(() => /Saved on this device|Offline/.test(document.querySelector('.state, .chip')?.textContent ?? ''), null, { timeout: 15_000 });

    // reload at once, without waiting for the autosave delay: the pending edit must be flushed as the page unloads
    await page.reload(); // served by the service worker, content from the local database
    await page.waitForSelector('.ProseMirror.doc', { timeout: 30_000 });
    await page.waitForFunction(() => /Written offline\./.test(document.querySelector('.ProseMirror')?.textContent ?? ''), null, { timeout: 30_000 });
    assert.equal(await page.inputValue('input.title'), 'Field notes');

    await ctx.setOffline(false);
    await page.waitForFunction(async () => {
      const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'X-Requested-With': 'os_planner' } });
      if (!r.ok) return false;
      const { accessToken } = await r.json();
      const pages = await (await fetch('/api/pages', { headers: { Authorization: `Bearer ${accessToken}` } })).json();
      const full = await (await fetch(`/api/pages/${pages[0].id}`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
      return JSON.stringify(full.content).includes('Written offline.');
    }, null, { timeout: 60_000, polling: 1500 });
    void email;
    await close();
  });

  test('two devices edit the same page offline: nothing is lost, the second one gets a conflict copy', T, async () => {
    const a = await device();
    const { email } = await register(a.page, base);
    await createNotebookAndPage(a.page, 'Shared');
    await writePage(a.page, 'Meeting', 'Original text.');
    await waitSaved(a.page);

    const b = await device();
    await login(b.page, base, email);
    await treeItem(b.page, 'Meeting').click();
    await b.page.waitForFunction(() => /Original text\./.test(document.querySelector('.ProseMirror')?.textContent ?? ''), null, { timeout: 30_000 });

    // both go offline and edit
    await a.ctx.setOffline(true);
    await b.ctx.setOffline(true);
    await endOfDoc(a.page);
    await a.page.keyboard.type(' Edit from A.');
    await endOfDoc(b.page);
    await b.page.keyboard.type(' Edit from B.');
    await a.page.waitForTimeout(1500);
    await b.page.waitForTimeout(1500);

    // A reconnects first and wins
    await a.ctx.setOffline(false);
    await a.page.waitForFunction(async () => {
      const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'X-Requested-With': 'os_planner' } });
      const { accessToken } = await r.json();
      const pages = await (await fetch('/api/pages', { headers: { Authorization: `Bearer ${accessToken}` } })).json();
      const full = await (await fetch(`/api/pages/${pages[0].id}`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
      return JSON.stringify(full.content).includes('Edit from A.');
    }, null, { timeout: 60_000, polling: 1500 });

    // B reconnects: its save is refused (the page moved on), so its text becomes a separate page
    await b.ctx.setOffline(false);
    await b.page.waitForSelector('app-tree-category .row.page:has-text("conflict copy")', { timeout: 60_000 });
    await b.page.waitForSelector('text=changed on another device');

    await b.page.locator('app-tree-category .row.page:has-text("conflict copy") a').click();
    await b.page.waitForFunction(() => /Edit from B\./.test(document.querySelector('.ProseMirror')?.textContent ?? ''));
    await treeItem(b.page, 'Meeting').first().click();
    await b.page.waitForFunction(() => /Edit from A\./.test(document.querySelector('.ProseMirror')?.textContent ?? ''), null, { timeout: 30_000 });
    assert.equal(await b.page.locator('.ProseMirror', { hasText: 'Edit from B.' }).count(), 0, 'the original page now shows A, not B');
    await a.close();
    await b.close();
  });
});

describe('exporting', () => {
  async function exportVia(page, trigger, format) {
    await trigger();
    await page.waitForSelector('app-export-dialog');
    if (format === 'markdown') await page.click('mat-button-toggle:has-text("Markdown") button');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('app-export-dialog button:has-text("Export")')]);
    return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
  }

  test('a page, a category and a whole notebook export to PDF, and Markdown exports as .md / .zip', T, async () => {
    const { page, close } = await device();
    const { email } = await register(page, base);
    await verify(page, email);
    await page.goto(`${base}/app`);
    await createNotebookAndPage(page, 'Export Book');
    await writePage(page, 'Chapter One', 'The quick brown fox jumps over the lazy dog.');
    await waitSaved(page, 40_000);

    const pdfjs = await import(pathToFileURL(resolve(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
    const textOf = async (bytes) => {
      const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      let out = '';
      for (let i = 1; i <= doc.numPages; i++) out += (await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ') + '\n';
      return out;
    };

    // page
    const pagePdf = await exportVia(page, () => page.click('button.export-btn'), 'pdf');
    assert.match(pagePdf.name, /^Chapter One\.pdf$/);
    assert.equal(pagePdf.bytes.subarray(0, 5).toString(), '%PDF-');
    assert.match(await textOf(pagePdf.bytes), /quick brown fox/);

    // category and notebook, from the sidebar menus
    const catRow = page.locator('app-tree-category .row', { hasText: 'General' }).first();
    const catPdf = await exportVia(page, async () => {
      await catRow.hover();
      await catRow.locator('button[aria-label="More"]').click();
      await page.click('button[role=menuitem]:has-text("Export")');
    }, 'pdf');
    assert.equal(catPdf.bytes.subarray(0, 5).toString(), '%PDF-');

    const nbRow = page.locator('app-tree .row.nb', { hasText: 'Export Book' });
    const nbPdf = await exportVia(page, async () => {
      await nbRow.hover();
      await nbRow.locator('button[aria-label="More"]').click();
      await page.click('button[role=menuitem]:has-text("Export")');
    }, 'pdf');
    assert.match(nbPdf.name, /^Export Book\.pdf$/);
    const nbText = await textOf(nbPdf.bytes);
    assert.match(nbText, /Export Book/); // the cover
    assert.match(nbText, /Chapter One/);
    assert.match(nbText, /Contents/);

    // Markdown: a single page without media is a plain .md
    const md = await exportVia(page, () => page.click('button.export-btn'), 'markdown');
    assert.match(md.name, /\.md$/);
    assert.match(md.bytes.toString('utf8'), /The quick brown fox/);

    // a notebook is a .zip
    const zip = await exportVia(page, async () => {
      await nbRow.hover();
      await nbRow.locator('button[aria-label="More"]').click();
      await page.click('button[role=menuitem]:has-text("Export")');
    }, 'markdown');
    assert.match(zip.name, /\.zip$/);
    assert.equal(zip.bytes.subarray(0, 2).toString(), 'PK');
    await close();
  });
});

describe('search, language and the public site', () => {
  test('search finds accented text with an unaccented query', T, async () => {
    const { page, close } = await device();
    await register(page, base);
    await createNotebookAndPage(page, 'Search');
    await writePage(page, 'Linguagem', 'A acentuação das palavras é importante.');
    await waitSaved(page);
    await page.waitForFunction(async () => {
      const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'X-Requested-With': 'os_planner' } });
      const { accessToken } = await r.json();
      const hits = await (await fetch('/api/search?q=acentuacao', { headers: { Authorization: `Bearer ${accessToken}` } })).json();
      return hits.length > 0;
    }, null, { timeout: 30_000, polling: 1000 });

    await page.fill('header.top input[name=q]', 'acentuacao');
    await page.keyboard.press('Enter');
    await page.waitForSelector('app-search-page li:has-text("Linguagem")');
    assert.ok(await page.locator('app-search-page mark').count() > 0, 'the match is highlighted');
    await close();
  });

  test('switching to Portuguese translates the interface and is remembered', T, async () => {
    const { page, close } = await device();
    await register(page, base);
    await page.click('a:has-text("Settings")');
    await page.waitForSelector('h1:has-text("Settings")');
    await page.click('mat-select');
    await page.click('mat-option:has-text("Português")');
    await page.waitForSelector('h1:has-text("Definições")');
    await page.reload();
    await page.waitForSelector('h1:has-text("Definições")');
    assert.equal(await page.locator('app-tree .title').textContent(), 'Cadernos');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'pt');
    await close();
  });

  test('the landing page renders and offers the download page', T, async () => {
    const { page, violations, close } = await device();
    await page.goto(base);
    await page.waitForSelector('h1');
    assert.match(await page.textContent('h1'), /Plans that go as far as your ideas/);
    await page.click('main a:has-text("Get the app")');
    await page.waitForURL('**/download');
    await page.waitForSelector('text=Install as an app');
    assert.deepEqual(violations.filter((v) => !/401/.test(v)), []);
    await close();
  });

  test('published desktop builds are listed on the download page, and the file downloads intact', T, async () => {
    const { ctx, page, close } = await device();
    const exe = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31) % 251));
    const deb = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 17) % 241));
    const auth = { Authorization: `Bearer ${RELEASE_TOKEN}` };
    for (const [name, data] of [['OS_Planner-9.9.9-setup.exe', exe], ['os-planner_9.9.9_amd64.deb', deb]]) {
      const put = await ctx.request.put(`${base}/api/admin/releases/files/${name}`, { headers: { ...auth, 'Content-Type': 'application/octet-stream' }, data });
      assert.equal(put.status(), 200);
    }
    const publish = await ctx.request.post(`${base}/api/admin/releases`, {
      headers: auth,
      data: {
        version: '9.9.9',
        notes: 'End-to-end release',
        files: [
          { name: 'OS_Planner-9.9.9-setup.exe', os: 'windows', arch: 'x64', format: 'nsis' },
          { name: 'os-planner_9.9.9_amd64.deb', os: 'linux', arch: 'x64', format: 'deb' },
        ],
      },
    });
    assert.equal(publish.status(), 200);

    await page.goto(`${base}/download`);
    await page.waitForSelector('text=End-to-end release');
    await page.waitForSelector('text=Debian / Ubuntu');
    assert.match(await page.textContent('app-apps-panel'), /sudo apt install/); // install hint for the .deb
    assert.ok(await page.locator(`text=SHA-256: ${createHash('sha256').update(deb).digest('hex').slice(0, 16)}`).count());

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('a[href="/downloads/os-planner_9.9.9_amd64.deb"]')]);
    assert.equal(createHash('sha256').update(await readFile(await download.path())).digest('hex'), createHash('sha256').update(deb).digest('hex'));
    await close();
  });
});

test('a session that is not allowed cannot read someone else\'s notes through the API', T, async () => {
  const a = await device();
  await register(a.page, base);
  await createNotebookAndPage(a.page, 'Private');
  await writePage(a.page, 'Secret page', 'top secret');
  await waitSaved(a.page);
  const mine = await apiGet(a.page, '/api/pages');
  assert.equal(mine.status, 200);
  const secretId = mine.body[0].id;

  const b = await device();
  await register(b.page, base, { email: uniqueEmail('other') });
  const stolen = await apiGet(b.page, `/api/pages/${secretId}`);
  assert.equal(stolen.status, 404);
  await a.close();
  await b.close();
});
