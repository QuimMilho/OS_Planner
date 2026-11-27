// Shared parts of the load and soak profiles: a server of its own on an isolated database, accounts, timing.
//
// Needs MySQL (`npm run db:up`) and a built server (`npm run build`). The server runs the production build with request throttling off (one
// machine plays thousands of people) and the team size raised. NODE_ENV stays development: the local database has the development password,
// which production refuses (nothing on the API's paths differs between the two).
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';

export const ROOT = resolve(import.meta.dirname, '../..');
const serverDir = resolve(ROOT, 'apps/server');
export const requireFromServer = createRequire(resolve(serverDir, 'package.json'));
const DB = process.env.LOAD_DB ?? 'notes_load';
const DB_URL = `mysql://notes:notes@localhost:3306/${DB}`;
export const ADMIN_EMAIL = 'load-admin@example.com';
export const PASSWORD = 'correct horse battery';

const secret = () => randomBytes(32).toString('base64url');

export async function sql(statement, params = []) {
  const mariadb = requireFromServer('mariadb');
  const conn = await mariadb.createConnection({
    host: 'localhost',
    port: 3306,
    user: 'notes',
    password: 'notes',
    database: DB,
    allowPublicKeyRetrieval: true,
  });
  try {
    return await conn.query(statement, params);
  } finally {
    await conn.end();
  }
}

async function freshDatabase() {
  const mariadb = requireFromServer('mariadb');
  const conn = await mariadb.createConnection({
    host: 'localhost',
    port: 3306,
    user: 'notes',
    password: 'notes',
    allowPublicKeyRetrieval: true,
  });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await conn.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await conn.end();
  }
  execFileSync(
    process.execPath,
    [requireFromServer.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: DB_URL },
      stdio: 'pipe',
    },
  );
}

/** Starts the built server on its own database. `env` adds or overrides settings. */
export async function startServer({
  port = Number(process.env.LOAD_PORT ?? 3200),
  env = {},
  fresh = true,
} = {}) {
  if (fresh) await freshDatabase();
  const dataDir = resolve(serverDir, '.load-data', DB); // one per database: two harness servers never clear each other's files
  if (fresh) rmSync(dataDir, { recursive: true, force: true });
  const baseUrl = `http://localhost:${port}`;
  const child = spawn(process.execPath, ['--expose-gc', 'dist/main.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      APP_URL: baseUrl,
      DATABASE_URL: DB_URL,
      DATA_DIR: dataDir,
      WEB_DIST_DIR: '',
      JWT_ACCESS_SECRET: secret(),
      JWT_MEDIA_SECRET: secret(),
      ADMIN_EMAILS: ADMIN_EMAIL,
      THROTTLE_DISABLED: 'true',
      MAX_MEMBERS_PER_TEAM: '5000',
      MAX_PROJECTS_PER_TEAM: '500',
      COLLAB_MIGRATE_ON_START: 'false',
      COLLAB_DEBOUNCE_MS: '500',
      NOTIFY_SWEEP_SECONDS: '0',
      ICS_ALLOW_HTTP: 'true',
      LOG_LEVEL: 'warn',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log = (log + d).slice(-20_000)));
  child.stderr.on('data', (d) => (log = (log + d).slice(-20_000)));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok)
        return { baseUrl, child, log: () => log, stop: () => stop(child) };
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    await sleep(500);
  }
  child.kill();
  throw new Error(`server did not become healthy:\n${log}`);
}

function stop(child) {
  return new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', () => r());
    child.kill();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small JSON client: `api(baseUrl, token).get('/api/me')`. Throws on 4xx/5xx with the body. */
export function api(baseUrl, token) {
  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    put: (p, b = {}) => call('PUT', p, b),
    patch: (p, b = {}) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  };
}

/** Runs `fn` over `items` with at most `limit` at once. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

let n = 0;
/** `count` verified accounts: `{ id, email, token }`. Registration hashes a password (argon2), so it runs a few at a time. */
export async function accounts(baseUrl, count, prefix = 'load') {
  const made = await pool(
    Array.from({ length: count }, (_, i) => i),
    8,
    async () => {
      const email = `${prefix}${Date.now()}${n++}@example.com`;
      const res = await api(baseUrl).post('/api/auth/register', {
        email,
        password: PASSWORD,
        displayName: `Load ${n}`,
      });
      return { id: res.user.id, email, token: res.accessToken };
    },
  );
  await sql('UPDATE `User` SET emailVerifiedAt = NOW(3) WHERE email LIKE ?', [`${prefix}%`]);
  return made;
}

export async function admin(baseUrl) {
  const res = await api(baseUrl).post('/api/auth/register', {
    email: ADMIN_EMAIL,
    password: PASSWORD,
    displayName: 'Load admin',
  });
  await sql('UPDATE `User` SET emailVerifiedAt = NOW(3) WHERE email = ?', [ADMIN_EMAIL]);
  return { id: res.user.id, email: ADMIN_EMAIL, token: res.accessToken };
}

/** A team owned by `owner` with `members` in it (added straight to the table: joining is not what is measured). */
export async function team(baseUrl, adminAccount, owner, members, extra = {}) {
  const t = await api(baseUrl, adminAccount.token).post('/api/admin/teams', {
    name: `Load team ${Date.now()}`,
    ownerEmail: owner.email,
    ...extra,
  });
  const [row] = await sql('SELECT spaceId FROM `Team` WHERE id = ?', [t.id]);
  for (let i = 0; i < members.length; i += 500) {
    const chunk = members.slice(i, i + 500);
    await sql(
      `INSERT IGNORE INTO \`TeamMember\` (teamId, userId) VALUES ${chunk.map(() => '(?, ?)').join(', ')}`,
      chunk.flatMap((m) => [t.id, m.id]),
    );
  }
  return { id: t.id, spaceId: row.spaceId };
}

export const uuid = () => randomUUID();

/** UUIDv7 (time first), what the web makes for message ids. */
export function uuidv7() {
  const ms = Date.now().toString(16).padStart(12, '0');
  const r = randomBytes(10).toString('hex');
  return `${ms.slice(0, 8)}-${ms.slice(8)}-7${r.slice(0, 3)}-${((parseInt(r[3], 16) & 3) | 8).toString(16)}${r.slice(4, 7)}-${r.slice(7, 19)}`;
}

export function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export const summary = (values) => ({
  n: values.length,
  p50: Math.round(percentile(values, 50) * 10) / 10,
  p95: Math.round(percentile(values, 95) * 10) / 10,
  max: Math.round(Math.max(...values) * 10) / 10,
});

/** The server's own numbers (memory, sockets, rooms, timers), from /api/metrics as the instance admin. */
export async function metrics(baseUrl, adminToken) {
  const res = await fetch(`${baseUrl}/api/metrics`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) throw new Error(`metrics: ${res.status}`);
  const out = {};
  for (const line of (await res.text()).split('\n')) {
    const m = /^([a-z_]+)(\{[^}]*\})? ([0-9.eE+-]+)$/.exec(line);
    if (m) out[`${m[1]}${m[2] ?? ''}`] = Number(m[3]);
  }
  return out;
}
