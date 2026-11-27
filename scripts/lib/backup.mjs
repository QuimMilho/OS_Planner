// Backup and restore of an OS_Planner instance: the MySQL database and DATA_DIR (uploads, desktop downloads).
// Used by scripts/backup.mjs and scripts/restore.mjs; the parts that need no database are unit-tested.
import { execFileSync, spawn } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/** `mysql://user:pass@host:port/db` -> its parts (decoded). */
export function parseDatabaseUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'mysql:') throw new Error('DATABASE_URL must start with mysql://');
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: Number(u.port || 3306),
    database: u.pathname.replace(/^\//, ''),
  };
}

/** A folder name that sorts by time: `2026-11-27T171500Z`. */
export const stamp = (d = new Date()) =>
  d
    .toISOString()
    .replace(/[:-]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace(/^(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');

/** How to run mysqldump/mysql: inside the compose service when `docker` is set (the usual install), else from the PATH. */
export function client(tool, db, { docker }) {
  const auth = [`-u${db.user}`, `-p${db.password}`];
  if (docker) return { cmd: 'docker', args: ['compose', 'exec', '-T', docker, tool, ...auth] };
  return { cmd: tool, args: [`-h${db.host}`, `-P${db.port}`, ...auth] };
}

/** Writes `<dir>/database.sql.gz`: a consistent dump (one transaction) of every table, without needing extra privileges. */
export async function dumpDatabase(db, dir, opts) {
  const { cmd, args } = client('mysqldump', db, opts);
  const child = spawn(
    cmd,
    [
      ...args,
      '--single-transaction',
      '--no-tablespaces',
      '--routines',
      '--triggers',
      '--hex-blob',
      '--default-character-set=utf8mb4',
      db.database,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((r, j) =>
    child.on('close', (code) =>
      code === 0
        ? r()
        : j(
            new Error(`mysqldump failed (${code}): ${err.replace(/.*Using a password.*\n?/g, '')}`),
          ),
    ),
  );
  await pipeline(child.stdout, createGzip(), createWriteStream(resolve(dir, 'database.sql.gz')));
  await done;
}

/** Loads `<dir>/database.sql.gz` into an empty database (dropped and created first). */
export async function loadDatabase(db, dir, opts) {
  const { cmd, args } = client('mysql', db, opts);
  execFileSync(
    cmd,
    [
      ...args,
      '-e',
      `DROP DATABASE IF EXISTS \`${db.database}\`; CREATE DATABASE \`${db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    ],
    { stdio: 'pipe' },
  );
  const child = spawn(cmd, [...args, '--default-character-set=utf8mb4', db.database], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((r, j) =>
    child.on('close', (code) =>
      code === 0
        ? r()
        : j(new Error(`mysql failed (${code}): ${err.replace(/.*Using a password.*\n?/g, '')}`)),
    ),
  );
  await pipeline(createReadStream(resolve(dir, 'database.sql.gz')), createGunzip(), child.stdin);
  await done;
}

/** Files under `dir` (relative paths) and their total size: what a manifest records and a restore checks. */
export function inventory(dir) {
  const files = [];
  let bytes = 0;
  const walk = (d, rel) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = resolve(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const s = statSync(p);
      if (s.isDirectory()) {
        if (r === 'tmp') continue; // uploads in progress
        walk(p, r);
      } else {
        files.push(r);
        bytes += s.size;
      }
    }
  };
  walk(dir, '');
  return { files: files.sort(), bytes };
}

/** Packs DATA_DIR into `<dir>/data.tar.gz` (tar ships with Linux, macOS and Windows 10+). */
export function packData(dataDir, dir) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  execFileSync(
    'tar',
    ['-czf', resolve(dir, 'data.tar.gz'), '--exclude', './tmp', '-C', dataDir, '.'],
    { stdio: 'pipe' },
  );
}

export function unpackData(dir, dataDir) {
  mkdirSync(dataDir, { recursive: true });
  execFileSync('tar', ['-xzf', resolve(dir, 'data.tar.gz'), '-C', dataDir], { stdio: 'pipe' });
}

export const writeManifest = (dir, manifest) =>
  writeFileSync(resolve(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
export const readManifest = (dir) =>
  JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));

/** The newest migration folder: what a backup was taken at (a restore then brings it up to date). */
export function lastMigration(root) {
  const dir = resolve(root, 'apps/server/prisma/migrations');
  return (
    readdirSync(dir)
      .filter((d) => /^\d{14}_/.test(d))
      .sort()
      .at(-1) ?? null
  );
}
