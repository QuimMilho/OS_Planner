#!/usr/bin/env node
// Restores a backup made by scripts/backup.mjs: REPLACES the database and DATA_DIR, then brings the schema up to date.
//
//   node scripts/restore.mjs backups/2026-11-27T171500Z --yes
//   node scripts/restore.mjs <folder> --yes --no-docker          mysql from the PATH
//
// Stop the server first (docker compose stop server). Afterwards start it again: it reads the restored data as it was.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  inventory,
  loadDatabase,
  parseDatabaseUrl,
  readManifest,
  unpackData,
} from './lib/backup.mjs';

const root = resolve(import.meta.dirname, '..');
const arg = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const folder = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!folder || !existsSync(resolve(folder, 'manifest.json')))
  throw new Error('usage: node scripts/restore.mjs <backup folder> --yes');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const databaseUrl = arg('database-url') ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');
const db = parseDatabaseUrl(databaseUrl);
const dataDir = resolve(root, 'apps/server', arg('data-dir') ?? process.env.DATA_DIR ?? './data');
const docker = process.argv.includes('--no-docker') ? null : (arg('docker-service') ?? 'mysql');
const manifest = readManifest(folder);

console.log(
  `backup of ${manifest.createdAt} (app ${manifest.app}, migration ${manifest.migration}, ${manifest.files} files)`,
);
console.log(`this REPLACES database "${db.database}" and the folder ${dataDir}`);
if (!process.argv.includes('--yes')) {
  console.log('nothing done: add --yes to go ahead');
  process.exit(2);
}

await loadDatabase(db, folder, { docker });
console.log('database restored');
rmSync(dataDir, { recursive: true, force: true });
unpackData(folder, dataDir);
const files = inventory(dataDir);
if (files.files.length !== manifest.files)
  throw new Error(
    `the files do not match the backup: ${files.files.length} restored, ${manifest.files} expected`,
  );
console.log(`${files.files.length} files restored`);

// a backup of an older version: the migrations since then run now (they are forward-only and keep the data)
const serverRequire = createRequire(resolve(root, 'apps/server/package.json'));
execFileSync(
  process.execPath,
  [serverRequire.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
  {
    cwd: resolve(root, 'apps/server'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  },
);
console.log('done: start the server again');
