// End-to-end: the realtime connection. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { launch, register, sql, startSite, startStack, uniqueEmail, verify } from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('rtadmin');
const EDIT_PAGES = 1n << 19n;

let stack;
let browser;
let base;

before(async () => {
  stack = await startStack({ env: { ADMIN_EMAILS: ADMIN_EMAIL } });
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await (await adminOnce)?.close();
  await browser?.close();
  await stack?.stop();
});

async function device(origin = base) {
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
  return { ctx, page, problems, origin, close: async () => ctx.close() };
}

async function account(name, wanted, origin = base) {
  const d = await device(origin);
  const { email } = await register(d.page, origin, { name, ...(wanted ? { email: wanted } : {}) });
  await verify(d.page, email);
  await d.page.goto(`${origin}/app`);
  await d.page.waitForSelector('app-rail');
  const id = (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;
  return { ...d, email, id, name };
}

let adminOnce;
/** The instance admin signs up once per stack. */
const getAdmin = () => (adminOnce ??= account('The Admin', ADMIN_EMAIL));

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

/** What the browser has stored about the person's permissions in a team (the permission store's source). */
function storedPermissions(page, who, teamId) {
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

/** Polls without nudging the app (no focus events, no reloads): only what the server pushes can make `check` true. */
async function passively(page, check, what, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > end) assert.fail(`gave up waiting for: ${what}`);
    await page.waitForTimeout(150);
  }
}

const indicator = (page) => page.locator('[data-realtime]');
const waitLive = (page, status = 'connected') =>
  page.locator(`[data-realtime][data-status="${status}"]`).waitFor({ timeout: 30_000 });
const liveStatus = (page) => indicator(page).getAttribute('data-status');

describe('realtime', () => {
  test(
    'a role given to a member reaches their open app at once, without a reload or a refocus',
    T,
    async () => {
      const admin = await getAdmin();
      const owner = await account('Olga Owner');
      const bea = await account('Bea Member');
      const teamId = await createTeam(admin, 'Live Inc', owner);
      await joinTeam(teamId, bea);

      // Bea reloads so her app knows the team, and keeps the page open and still.
      await bea.page.goto(`${base}/app/t/${teamId}`);
      await bea.page.waitForSelector('[data-team-page]');
      await waitLive(bea.page);
      const before = await passively(
        bea.page,
        () => storedPermissions(bea.page, bea, teamId),
        'Bea’s permissions are stored',
      );
      assert.equal((BigInt(before.permissions) & EDIT_PAGES) !== 0n, false);

      const role = await api(owner.page, 'POST', `/api/teams/${teamId}/roles`, {
        name: 'Reviewer',
        permissions: EDIT_PAGES.toString(),
      });
      assert.equal(role.status, 201, JSON.stringify(role.body));
      // The owner does it in the UI: the members tab, "add role".
      await owner.page.goto(`${base}/app/t/${teamId}/settings?tab=members`);
      const row = owner.page.locator(`[data-member-id="${bea.id}"]`);
      await row.waitFor();
      await row.locator('[data-action=add-role]').click();
      await owner.page.click('[data-role-option="Reviewer"]');
      await row.locator('[data-chip="Reviewer"]').waitFor();

      await passively(
        bea.page,
        async () => {
          const stored = await storedPermissions(bea.page, bea, teamId);
          return stored && (BigInt(stored.permissions) & EDIT_PAGES) !== 0n;
        },
        'Bea’s stored permissions now include Edit pages',
      );

      // ...and the same when it is taken away.
      await row.locator('[data-chip="Reviewer"] [data-action=remove-role]').click();
      await row.locator('[data-chip="Reviewer"]').waitFor({ state: 'detached' });
      await passively(
        bea.page,
        async () => {
          const stored = await storedPermissions(bea.page, bea, teamId);
          return stored && (BigInt(stored.permissions) & EDIT_PAGES) === 0n;
        },
        'Bea’s stored permissions no longer include Edit pages',
      );
      assert.deepEqual(
        [owner, bea].flatMap((d) => d.problems),
        [],
      );
      for (const d of [owner, bea]) await d.close();
    },
  );

  test(
    'losing the connection shows it in the top bar; getting it back reconnects and catches up on what was missed',
    T,
    async () => {
      const admin = await getAdmin();
      const owner = await account('Olga Owner');
      const bea = await account('Bea Member');
      const id = await createTeam(admin, 'Flaky Inc', owner);
      await joinTeam(id, bea);

      await bea.page.goto(`${base}/app/t/${id}`);
      await bea.page.waitForSelector('[data-team-page]');
      await waitLive(bea.page);

      // the network goes away: the top bar says so (reconnecting while the browser still thinks it is online)
      await bea.ctx.setOffline(true);
      await passively(
        bea.page,
        async () => (await liveStatus(bea.page)) !== 'connected',
        'the indicator leaves "connected"',
      );
      assert.match(await liveStatus(bea.page), /^(connecting|offline)$/);

      // while she is away the owner changes what she may do: the event is not replayed, so the app must catch up
      const role = await api(owner.page, 'POST', `/api/teams/${id}/roles`, {
        name: 'Reviewer',
        permissions: EDIT_PAGES.toString(),
      });
      assert.equal(role.status, 201, JSON.stringify(role.body));
      assert.equal(
        (await api(owner.page, 'PUT', `/api/teams/${id}/members/${bea.id}/roles/${role.body.id}`))
          .status,
        204,
      );

      let extraRefreshes = 0;
      bea.page.on(
        'request',
        (r) => /\/api\/teams\/[0-9a-f-]+\/me$/.test(new URL(r.url()).pathname) && extraRefreshes++,
      );
      await bea.ctx.setOffline(false);
      await waitLive(bea.page);
      await passively(
        bea.page,
        async () => {
          const stored = await storedPermissions(bea.page, bea, id);
          return stored && (BigInt(stored.permissions) & EDIT_PAGES) !== 0n;
        },
        'after reconnecting the app caught up with the role given meanwhile',
        30_000,
      );
      // The catch-up is one round of requests, not a storm.
      assert.ok(extraRefreshes <= 3, `permissions were read ${extraRefreshes} times`);
      for (const d of [owner, bea]) await d.close();
    },
  );
});

describe('realtime with the website and the API on different origins', () => {
  const API_PORT = Number(process.env.E2E_RT_API_PORT ?? 3103);
  const SITE_PORT = Number(process.env.E2E_RT_SITE_PORT ?? 4303);
  const API = `http://localhost:${API_PORT}`;
  const SITE = `http://localhost:${SITE_PORT}`;
  let api;
  let site;

  before(async () => {
    api = await startStack({
      port: API_PORT,
      serveWeb: false,
      env: { APP_URL: SITE, CORS_ORIGINS: SITE },
    });
    site = await startSite({ port: SITE_PORT, apiUrl: API });
  });
  after(async () => {
    await site?.stop();
    await api?.stop();
  });

  /** An Engine.IO polling handshake as a browser of `origin` would start it; resolves with the HTTP status. */
  const handshake = (origin) =>
    new Promise((resolve, reject) => {
      const req = request(
        `${API}/api/realtime/?EIO=4&transport=polling`,
        { headers: { Origin: origin } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });

  test(
    'the page of the website connects to the API origin and shows live; a stranger origin is refused',
    T,
    async () => {
      const d = await device(SITE);
      const sockets = [];
      d.page.on('websocket', (ws) => sockets.push(ws.url()));
      const { email } = await register(d.page, SITE);
      await verify(d.page, email);
      await d.page.goto(`${SITE}/app`);
      await d.page.waitForSelector('app-rail');
      await waitLive(d.page);
      assert.ok(
        sockets.some((u) => u.startsWith(`ws://localhost:${API_PORT}/api/realtime/`)),
        `a socket went to the API (saw ${sockets.join(', ')})`,
      );
      assert.deepEqual(
        d.problems,
        [],
        'the site’s Content-Security-Policy lets the socket through',
      );

      assert.equal(await handshake(SITE), 200);
      assert.notEqual(await handshake('https://stranger.example'), 200);
      await d.close();
    },
  );
});
