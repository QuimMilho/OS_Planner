// Test harness for the browser end-to-end suite: provisions an isolated database, starts the real
// server (which also serves the built web app), and offers helpers shared by the tests.
//
// Needs: `docker compose up -d mysql mailpit`, and `npm run build` (shared, web, server) beforehand.
// Set E2E_BASE_URL to run against a server you started yourself.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';

export const ROOT = resolve(import.meta.dirname, '../../..');
const root = ROOT;
const serverDir = resolve(root, 'apps/server');
const requireFromServer = createRequire(resolve(serverDir, 'package.json'));

export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const RELEASE_TOKEN = 'e2e-release-token-0123456789abcdefghij';
export const PASSWORD = 'correct horse battery';
const DB = 'notes_e2e';

async function ensureDatabase() {
  const mariadb = requireFromServer('mariadb');
  const conn = await mariadb.createConnection({ host: 'localhost', port: 3306, user: 'notes', password: 'notes', allowPublicKeyRetrieval: true });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await conn.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await conn.end();
  }
  execFileSync(process.execPath, [requireFromServer.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: `mysql://notes:notes@localhost:3306/${DB}` },
    stdio: 'pipe',
  });
}

/**
 * Starts the stack (unless E2E_BASE_URL points at one) and returns its base URL and a stop function.
 * Options: `port`, `serveWeb: false` for an API without a website, and `env` to add or override server settings.
 */
export async function startStack({ port = PORT, serveWeb = true, env: extraEnv = {} } = {}) {
  if (process.env.E2E_BASE_URL) return { baseUrl: process.env.E2E_BASE_URL, stop: async () => {} };

  await ensureDatabase();
  const dataDir = resolve(serverDir, '.e2e-data');
  rmSync(dataDir, { recursive: true, force: true });
  const baseUrl = `http://localhost:${port}`;
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      APP_URL: baseUrl,
      DATABASE_URL: `mysql://notes:notes@localhost:3306/${DB}`,
      WEB_DIST_DIR: serveWeb ? resolve(root, 'apps/web/dist/web/browser') : '',
      DATA_DIR: dataDir,
      RELEASE_TOKEN,
      THROTTLE_DISABLED: 'true',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return { baseUrl, stop: async () => void child.kill() };
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`server did not become healthy:\n${log}`);
}

/** Runs one statement against the e2e database: for setting up what the app has no screen for yet (adding a member to a team). */
export async function sql(statement, params = []) {
  const mariadb = requireFromServer('mariadb');
  const conn = await mariadb.createConnection({ host: 'localhost', port: 3306, user: 'notes', password: 'notes', database: DB, allowPublicKeyRetrieval: true });
  try {
    return await conn.query(statement, params);
  } finally {
    await conn.end();
  }
}

export const launch = () => chromium.launch({ channel: 'chrome', headless: true });

let counter = 0;
export const uniqueEmail = (p = 'e2e') => `${p}${Date.now()}${counter++}@example.com`;

/** Waits for a message to `to` whose subject contains `subject`, and returns its text body. */
export async function waitForMail(to, subject, { since = 0, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const { messages = [] } = await res.json();
    const hit = messages.filter((m) => m.Subject.includes(subject) && new Date(m.Created).getTime() >= since).at(0);
    if (hit) return (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()).Text;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`no mail "${subject}" for ${to}`);
}

export const linkIn = (text) => /https?:\/\/\S+/.exec(text)?.[0];

/** Registers through the UI and lands in the app. */
export async function register(page, baseUrl, { name = 'E2E User', email = uniqueEmail(), password = PASSWORD } = {}) {
  await page.goto(`${baseUrl}/register`);
  await page.fill('input[name=name]', name);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/app');
  await page.waitForSelector('app-shell');
  return { email, password, name };
}

/** A real PNG (solid colour) for upload tests. */
export function makePng(width = 64, height = 48, color = '#2f9e44') {
  return requireFromServer('sharp')({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

/** A PNG of random noise: it does not compress, so its size is predictable (about 3 bytes per pixel). */
export function makeNoisePng(side = 100) {
  return requireFromServer('sharp')({
    create: { width: side, height: side, channels: 3, background: '#000', noise: { type: 'gaussian', mean: 128, sigma: 60 } },
  })
    .png()
    .toBuffer();
}

/** Opens the verification link from the mail, then waits for the app to notice. */
export async function verify(page, email) {
  const body = await waitForMail(email, 'Confirm');
  await page.goto(linkIn(body));
  await page.waitForSelector('text=Your email is confirmed');
}

export async function login(page, baseUrl, email, password = PASSWORD) {
  await page.goto(`${baseUrl}/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/app');
  await page.waitForSelector('app-shell');
}

/** Creates a notebook (via the home call-to-action) and a first page in its "General" category. */
export async function createNotebookAndPage(page, notebook = 'Notebook') {
  await page.click('text=Create your first notebook');
  await page.waitForSelector('app-inline-name input.edit');
  await page.keyboard.type(notebook);
  await page.keyboard.press('Enter');
  const row = page.locator('app-tree-category .row', { hasText: 'General' }).first();
  await row.hover();
  await row.locator('button[aria-label="New page"]').click();
  await page.waitForSelector('.ProseMirror.doc');
}

/** Types into the title, then the body. */
export async function writePage(page, title, body) {
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  if (body) await page.keyboard.type(body);
}

/**
 * Resolves once the service worker has downloaded the app: it becomes "active" before its cache is
 * complete, and cutting the network too early would make an offline reload fail for a test-only reason.
 */
export const waitForOfflineReady = (page, timeout = 120_000) =>
  page.waitForFunction(
    async () => {
      if (!(await navigator.serviceWorker?.getRegistration())?.active) return false;
      for (const name of await caches.keys()) {
        const urls = (await (await caches.open(name)).keys()).map((r) => r.url);
        if (urls.some((u) => /\/index\.html$|\/$/.test(u)) && urls.some((u) => /\/main-[A-Z0-9]+\.js$/i.test(u)) && urls.some((u) => /\/chunk-.*\.js$/.test(u))) return true;
      }
      return false;
    },
    null,
    { timeout, polling: 1000 },
  );

export const waitSaved = (page, timeout = 20_000) =>
  page.waitForFunction(() => /Saved(?! on this device)/.test(document.querySelector('.state')?.textContent ?? ''), null, { timeout });

/** Reads a page's content from the API as the signed-in user (from inside the page, so cookies apply). */
export async function apiGet(page, path) {
  return page.evaluate(async (p) => {
    const refresh = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'X-Requested-With': 'os_planner' } });
    const { accessToken } = await refresh.json();
    const res = await fetch(p, { headers: { Authorization: `Bearer ${accessToken}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, path);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain', '.map': 'application/json',
};

/**
 * Serves a copy of the built website from its own origin, the way a static host or CDN would, with the strict
 * Content-Security-Policy such a host needs once the API lives elsewhere (that origin in connect/img/media-src).
 * `apiUrl` goes into the copy's config.json; `setApiUrl` edits it afterwards, like a deployer would.
 */
export async function startSite({ port, apiUrl }) {
  const dir = mkdtempSync(join(tmpdir(), 'os-planner-site-'));
  cpSync(resolve(root, 'apps/web/dist/web/browser'), dir, { recursive: true });
  let current = apiUrl;
  const setApiUrl = (value) => {
    current = value;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ apiUrl: value }));
  };
  setApiUrl(apiUrl);

  // A host that serves the site must allow the API origin itself; it follows config.json.
  const csp = () =>
    [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${current}`, `media-src 'self' blob: ${current}`, "font-src 'self' data:",
      // a CSP host source with http(s) does not cover the realtime WebSocket (ws/wss): list it too
      `connect-src 'self' ${current} ${current.replace(/^http/, 'ws')}`, "worker-src 'self' blob:", "manifest-src 'self'", "object-src 'none'", "frame-ancestors 'none'",
    ].join('; ');

  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = resolve(dir, '.' + path);
    const inside = file === dir || file.startsWith(dir + sep);
    // Routes of the single-page app (no file extension) get index.html, like a static host's fallback rule.
    if (!inside || !extname(path)) file = join(dir, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const name = file.slice(dir.length + 1);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Security-Policy': csp(),
      'Cache-Control': /^(index.html|config.json|ngsw.json|ngsw-worker.js|manifest.webmanifest)$/.test(name) ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(readFileSync(file));
  });
  await new Promise((ok, fail) => server.once('error', fail).listen(port, ok));
  return {
    url: `http://localhost:${port}`,
    setApiUrl,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
