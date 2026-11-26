// End-to-end: the website and the API on DIFFERENT origins (a static site on :4300, the API alone on :3101).
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
//
// localhost:4300 and localhost:3101 are the same *site* (browsers ignore the port), so the default SameSite=Strict
// refresh cookie works here; what is exercised is CORS, credentials, the CSP of the static host and CORP for media.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import {
  RELEASE_TOKEN, createNotebookAndPage, launch, makePng, register, startSite, startStack, verify, waitSaved, writePage,
} from './harness.mjs';

const T = { timeout: 180_000 };
const API_PORT = Number(process.env.E2E_API_PORT ?? 3101);
const SITE_PORT = Number(process.env.E2E_SITE_PORT ?? 4300);
const API = `http://localhost:${API_PORT}`;
const SITE = `http://localhost:${SITE_PORT}`;

let api;
let site;
let browser;

before(async () => {
  // The API has no website of its own, and APP_URL (links in emails) is the website.
  api = await startStack({ port: API_PORT, serveWeb: false, env: { APP_URL: SITE, CORS_ORIGINS: SITE } });
  site = await startSite({ port: SITE_PORT, apiUrl: API });
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await site?.stop();
  await api?.stop();
});

/** A fresh browser profile that records where the app sends its API calls and anything the CSP blocks. */
async function device() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const apiOrigins = new Set();
  const failed = [];
  const requested = [];
  const violations = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/downloads/')) {
      apiOrigins.add(u.origin);
      requested.push(r.url());
    }
  });
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('console', (m) => /Content Security Policy|violates the following|CORS|Access-Control/i.test(m.text()) && violations.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message.slice(0, 200)}`));
  return { ctx, page, apiOrigins, failed, requested, violations, close: async () => ctx.close() };
}

describe('website and API on different origins', () => {
  test('sign up, confirm the email, reload and stay signed in: every call goes to the API origin', T, async () => {
    const { page, apiOrigins, violations, close } = await device();
    const { email } = await register(page, SITE);
    await page.waitForSelector('text=Please confirm your email');
    await verify(page, email); // the link in the mail points at the website (APP_URL)

    // A reload resumes the session from the refresh cookie, which the API set cross-origin.
    await page.goto(`${SITE}/app`);
    await page.waitForSelector('app-shell');
    assert.equal(await page.locator('text=Please confirm your email').count(), 0);
    assert.equal(page.url(), `${SITE}/app`, 'still signed in after a reload (not sent back to /login)');

    assert.deepEqual([...apiOrigins], [API], 'no API request ever went to the website origin');
    assert.deepEqual(violations, []);
    await close();
  });

  test('an uploaded image is stored through the API, shows up on a second device, and can be embedded from the API origin', T, async () => {
    const a = await device();
    const { email } = await register(a.page, SITE);
    await verify(a.page, email);
    await a.page.goto(`${SITE}/app`);
    await createNotebookAndPage(a.page, 'Pictures');
    await writePage(a.page, 'With image', 'A picture:');
    await a.page.click('button:has-text("Insert")');
    await a.page.click('button[role=menuitem]:has-text("Image")');
    await a.page.setInputFiles('input[type=file]', { name: 'green.png', mimeType: 'image/png', buffer: await makePng(120, 80) });
    await a.page.waitForSelector('app-image-figure-view img');
    await waitSaved(a.page, 40_000);

    // The upload reached the API: the mediaId is in the stored document and the quota went up.
    const stored = await a.page.evaluate(async (apiOrigin) => {
      const refresh = await fetch(`${apiOrigin}/api/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'os_planner' } });
      const { accessToken } = await refresh.json();
      const auth = { Authorization: `Bearer ${accessToken}` };
      const list = await (await fetch(`${apiOrigin}/api/pages`, { headers: auth })).json();
      const page = await (await fetch(`${apiOrigin}/api/pages/${list[0].id}`, { headers: auth })).json();
      const mediaId = /"mediaId":"([0-9a-f-]{36})"/.exec(JSON.stringify(page.content))?.[1];
      const token = (await (await fetch(`${apiOrigin}/api/auth/media-token`, { method: 'POST', headers: auth })).json()).token;
      // What <img src> does: a plain cross-origin load with no headers. Needs Cross-Origin-Resource-Policy: cross-origin and img-src.
      const width = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth);
        img.onerror = () => resolve(0);
        img.src = `${apiOrigin}/api/media/${mediaId}?t=${encodeURIComponent(token)}`;
      });
      return { mediaId, width };
    }, API);
    assert.ok(stored.mediaId, 'the image is referenced by the saved document');
    assert.equal(stored.width, 120, 'an <img> on the website can load media straight from the API origin');

    // A brand-new device downloads it from the API.
    const b = await device();
    await b.page.goto(`${SITE}/login`);
    await b.page.fill('input[name=email]', email);
    await b.page.fill('input[name=password]', 'correct horse battery');
    await b.page.click('button[type=submit]');
    await b.page.waitForURL('**/app');
    await b.page.locator('app-tree-category .row.page', { hasText: 'With image' }).click();
    await b.page.locator('app-image-figure-view img').waitFor({ timeout: 30_000 });
    await b.page.waitForFunction(() => document.querySelector('app-image-figure-view img')?.naturalWidth === 120, null, { timeout: 30_000 });

    assert.deepEqual([...a.violations, ...b.violations], []);
    assert.deepEqual([...a.apiOrigins, ...b.apiOrigins].filter((o) => o !== API), []);
    await a.close();
    await b.close();
  });

  test('the download page lists builds from the API and downloads them from there', T, async () => {
    const { ctx, page, apiOrigins, violations, close } = await device();
    const deb = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 17) % 241));
    const auth = { Authorization: `Bearer ${RELEASE_TOKEN}` };
    const put = await ctx.request.put(`${API}/api/admin/releases/files/os-planner_8.8.8_amd64.deb`, { headers: { ...auth, 'Content-Type': 'application/octet-stream' }, data: deb });
    assert.equal(put.status(), 200);
    const publish = await ctx.request.post(`${API}/api/admin/releases`, {
      headers: auth,
      data: { version: '8.8.8', notes: 'Cross-origin release', files: [{ name: 'os-planner_8.8.8_amd64.deb', os: 'linux', arch: 'x64', format: 'deb' }] },
    });
    assert.equal(publish.status(), 200);

    await page.goto(`${SITE}/download`);
    await page.waitForSelector('text=Cross-origin release');
    const link = page.locator('a[href$="/downloads/os-planner_8.8.8_amd64.deb"]');
    assert.equal(await link.getAttribute('href'), `${API}/downloads/os-planner_8.8.8_amd64.deb`, 'the link points at the API, not at the website');

    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    assert.equal(createHash('sha256').update(await readFile(await download.path())).digest('hex'), createHash('sha256').update(deb).digest('hex'));
    assert.ok(apiOrigins.has(API));
    assert.deepEqual(violations, []);
    await close();
  });

  test('another website is not allowed to use the API with a visitor cookie', T, async () => {
    const { page, close } = await device();
    // An unrelated origin (the same static host under another name): 127.0.0.1 is not in CORS_ORIGINS.
    await page.goto(`http://127.0.0.1:${SITE_PORT}/login`);
    const result = await page.evaluate(async (apiOrigin) => {
      try {
        await fetch(`${apiOrigin}/api/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'os_planner' } });
        return 'allowed';
      } catch {
        return 'blocked';
      }
    }, API);
    // (the page's own CSP would also stop this, so the server side is asserted from the response headers below)
    assert.equal(result, 'blocked');
    const preflight = await fetch(`${API}/api/auth/refresh`, {
      method: 'OPTIONS',
      headers: { Origin: `http://127.0.0.1:${SITE_PORT}`, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-requested-with' },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null, 'the API does not name the stranger');
    const allowed = await fetch(`${API}/api/auth/refresh`, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), SITE);
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
    await close();
  });

  test('editing config.json repoints the website without a rebuild', T, async () => {
    const { page, requested, close } = await device();
    site.setApiUrl('http://localhost:3199'); // nothing listens there
    try {
      await page.goto(`${SITE}/login`);
      await page.waitForSelector('input[name=email]');
      await page.fill('input[name=email]', 'nobody@example.com');
      await page.fill('input[name=password]', 'correct horse battery');
      await page.click('button[type=submit]');
      await page.waitForFunction(() => true); // let the click be processed
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !requested.some((u) => u.startsWith('http://localhost:3199/api/auth/login'))) await new Promise((r) => setTimeout(r, 200));
      assert.ok(requested.some((u) => u.startsWith('http://localhost:3199/api/auth/login')), `the sign-in was sent to the new address (saw: ${requested.join(', ')})`);
      assert.ok(!requested.some((u) => u.startsWith(API)), 'and nothing went to the old one');
    } finally {
      site.setApiUrl(API);
      await close();
    }
  });
});
